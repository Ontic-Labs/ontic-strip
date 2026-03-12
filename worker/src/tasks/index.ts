import type { TaskList } from "graphile-worker";
import { createClient } from "@supabase/supabase-js";

type PipelineStagePayload = {
  document_id?: string;
  stage?: string;
  status_token?: string;
  attempt?: number;
  source?: string;
};

const MAX_ATTEMPTS = 3;
const EDGE_FN_TIMEOUT_MS = 120_000;

const STAGE_MAX_ATTEMPTS: Record<string, number> = {
  NORMALIZE: 2,
  INDEX: 3,
  CLASSIFY: 3,
  EXTRACT: 3,
  EVIDENCE: 3,
  VERACITY: 5,
  AGGREGATE: 3,
  SENTIMENT: 2,
  SYNTHESIS: 2,
  IDEOLOGY: 2,
  ENRICH: 4,
};

const STAGE_FUNCTION: Record<string, string> = {
  NORMALIZE: "normalizer",
  INDEX: "indexer",
  CLASSIFY: "oracle-classifier",
  EXTRACT: "oracle-extractor",
  EVIDENCE: "oracle-evidence",
  VERACITY: "oracle-veracity",
  AGGREGATE: "aggregator",
  SENTIMENT: "oracle-sentiment",
  SYNTHESIS: "oracle-synthesis",
  IDEOLOGY: "oracle-ideology",
  ENRICH: "event-enricher",
};

const STAGE_EXPECTED_STATUS: Record<string, string> = {
  NORMALIZE: "normalizing",
  INDEX: "pending",
  CLASSIFY: "classifying",
  EXTRACT: "extracting",
  EVIDENCE: "verifying",
  VERACITY: "verifying",
  AGGREGATE: "aggregated",
  SENTIMENT: "aggregated",
  SYNTHESIS: "aggregated",
  IDEOLOGY: "aggregated",
  ENRICH: "aggregated",
};

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function buildSupabaseAdminClient() {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    supabaseUrl,
    serviceRoleKey,
    client: createClient(supabaseUrl, serviceRoleKey),
  };
}

async function runPipelineStage(rawPayload: unknown, helpers: any) {
  const payload = (rawPayload ?? {}) as PipelineStagePayload;
  const stage = String(payload.stage || "").toUpperCase();
  const functionName = STAGE_FUNCTION[stage];
  const expectedStatus = STAGE_EXPECTED_STATUS[stage] ?? null;
  const attempt = Number.isFinite(payload.attempt) && (payload.attempt ?? 0) > 0
    ? Number(payload.attempt)
    : 1;
  const stageMaxAttempts = STAGE_MAX_ATTEMPTS[stage] ?? MAX_ATTEMPTS;
  const documentId = payload.document_id ?? null;

  if (!documentId) {
    throw new Error("pipeline.run_stage requires payload.document_id");
  }

  if (!functionName) {
    throw new Error(`pipeline.run_stage received unknown stage: ${stage}`);
  }

  const startedAt = Date.now();
  const { supabaseUrl, serviceRoleKey, client } = buildSupabaseAdminClient();

  const { data: pausedData } = await client.rpc("pipeline_stage_is_paused", {
    p_stage: stage,
  });

  if (pausedData === true) {
    // Re-enqueue with a 60s delay so the job isn't lost while paused
    await client.rpc("enqueue_graphile_stage_job", {
      p_doc_id: documentId,
      p_stage: stage,
      p_status_token: payload.status_token ?? expectedStatus ?? stage.toLowerCase(),
      p_attempt: attempt,
      p_run_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await client.rpc("pipeline_record_stage_metric", {
      p_document_id: documentId,
      p_stage: stage,
      p_status: "deferred",
      p_attempt: attempt,
      p_duration_ms: Date.now() - startedAt,
      p_error_message: "stage_paused_reenqueued",
    });
    helpers.logger.info("pipeline.run_stage deferred (paused, re-enqueued)", { stage, documentId, attempt });
    return;
  }

  if (expectedStatus) {
    const { data: doc } = await client
      .from("documents")
      .select("pipeline_status")
      .eq("id", documentId)
      .single();

    if (!doc || doc.pipeline_status !== expectedStatus) {
      await client.rpc("pipeline_record_stage_metric", {
        p_document_id: documentId,
        p_stage: stage,
        p_status: "skipped",
        p_attempt: attempt,
        p_duration_ms: Date.now() - startedAt,
        p_error_message: `expected_${expectedStatus}_got_${doc?.pipeline_status ?? "null"}`,
      });

      helpers.logger.info("pipeline.run_stage skipped (status mismatch)", {
        stage,
        documentId,
        expectedStatus,
        actualStatus: doc?.pipeline_status ?? null,
      });
      return;
    }
  }

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ document_id: documentId }),
      signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err = new Error(`${functionName} returned ${resp.status}: ${errText.slice(0, 200)}`);
      // 422 = permanent failure (e.g. insufficient content) — skip retries
      (err as any).permanent = resp.status === 422;
      throw err;
    }

    await resp.text();

    if (stage === "VERACITY") {
      const { data: remaining } = await client
        .from("claims")
        .select("id")
        .eq("document_id", documentId)
        .is("veracity_label", null)
        .limit(1);

      const { data: docCheck } = await client
        .from("documents")
        .select("pipeline_status")
        .eq("id", documentId)
        .single();

      if (remaining && remaining.length > 0 && docCheck?.pipeline_status === "verifying") {
        await client.rpc("enqueue_graphile_stage_job", {
          p_doc_id: documentId,
          p_stage: "VERACITY",
          p_status_token: "verifying",
          p_attempt: 1,
        });
      }
    }

    await client.rpc("pipeline_record_stage_metric", {
      p_document_id: documentId,
      p_stage: stage,
      p_status: "ok",
      p_attempt: attempt,
      p_duration_ms: Date.now() - startedAt,
      p_error_message: null,
    });

    await client.rpc("pipeline_stage_mark_success", { p_stage: stage });

    helpers.logger.info("pipeline.run_stage completed", {
      stage,
      documentId,
      attempt,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);

    try {
      await client.rpc("pipeline_record_stage_metric", {
        p_document_id: documentId,
        p_stage: stage,
        p_status: "failed",
        p_attempt: attempt,
        p_duration_ms: Date.now() - startedAt,
        p_error_message: errMessage,
      });

      await client.rpc("pipeline_stage_mark_failure", {
        p_stage: stage,
        p_reason: errMessage,
      });

      const isPermanent = !!(error as any)?.permanent;
      if (!isPermanent && attempt < stageMaxAttempts) {
        await client.rpc("enqueue_graphile_stage_job", {
          p_doc_id: documentId,
          p_stage: stage,
          p_status_token: payload.status_token ?? expectedStatus ?? stage.toLowerCase(),
          p_attempt: attempt + 1,
        });
      } else {
        // Mark document as failed so it doesn't appear stuck
        await client
          .from("documents")
          .update({ pipeline_status: "failed" })
          .eq("id", documentId);

        // Clear guard row so a manual retry can re-enqueue
        await client
          .from("pipeline_enqueue_guard")
          .delete()
          .eq("doc_id", documentId)
          .eq("stage", stage);

        await client.from("pipeline_dlq").insert({
          doc_id: documentId,
          stage,
          attempt,
          error_message: errMessage,
          payload,
        });
      }
    } catch (innerErr) {
      helpers.logger.error("pipeline.run_stage error handler failed", {
        stage,
        documentId,
        attempt,
        originalError: errMessage,
        innerError: innerErr instanceof Error ? innerErr.message : String(innerErr),
      });
    }

    helpers.logger.error("pipeline.run_stage failed", {
      stage,
      documentId,
      attempt,
      errorMessage: errMessage,
    });
  }
}

export const taskList: TaskList = {
  "pipeline.run_stage": async (rawPayload, helpers) => {
    await runPipelineStage(rawPayload, helpers);
  },
};
