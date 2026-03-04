import type { TaskList } from "graphile-worker";
import { createClient } from "@supabase/supabase-js";

type ShadowSentimentPayload = {
  document_id?: string;
  stage?: string;
  status_token?: string;
  attempt?: number;
  source?: string;
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

export const taskList: TaskList = {
  "pipeline.shadow_sentiment": async (rawPayload, helpers) => {
    const payload = (rawPayload ?? {}) as ShadowSentimentPayload;
    const startedAt = Date.now();
    const stage = "SENTIMENT";
    const documentId = payload.document_id ?? null;

    if (!documentId) {
      throw new Error("pipeline.shadow_sentiment requires payload.document_id");
    }

    const { supabaseUrl, serviceRoleKey, client } = buildSupabaseAdminClient();

    let status: "ok" | "failed" = "ok";
    let httpStatus: number | null = null;
    let responseBody: unknown = null;
    let errorMessage: string | null = null;

    try {
      const resp = await fetch(`${supabaseUrl}/functions/v1/oracle-sentiment`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          document_id: documentId,
          batch_size: 5,
        }),
      });

      httpStatus = resp.status;
      const text = await resp.text();
      try {
        responseBody = text ? JSON.parse(text) : null;
      } catch {
        responseBody = { raw: text.slice(0, 2000) };
      }

      if (!resp.ok) {
        status = "failed";
        errorMessage = `oracle-sentiment returned ${resp.status}`;
      }
    } catch (error) {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const durationMs = Date.now() - startedAt;

    const { error: insertError } = await client
      .from("graphile_shadow_runs")
      .insert({
        stage,
        document_id: documentId,
        status,
        http_status: httpStatus,
        duration_ms: durationMs,
        source: "graphile_worker",
        error_message: errorMessage,
        payload,
        response: responseBody,
      });

    if (insertError) {
      helpers.logger.error("Failed to persist graphile shadow run", { insertError });
    }

    helpers.logger.info("pipeline.shadow_sentiment completed", {
      stage,
      documentId,
      status,
      httpStatus,
      durationMs,
      errorMessage,
    });

    if (status === "failed") {
      throw new Error(errorMessage ?? "pipeline.shadow_sentiment failed");
    }
  },
};
