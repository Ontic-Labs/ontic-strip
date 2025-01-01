import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_ATTEMPTS = 3;
const VISIBILITY_TIMEOUT_S = 90;
const DEFAULT_MAX_MESSAGES = 20;
const CONCURRENCY_LIMIT = 6;
const MAX_DRAIN_CYCLES = 8;
const MAX_QTY = 120;
const MIN_QTY = 10;
const MAX_CONCURRENCY = 12;
const MIN_CONCURRENCY = 3;

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

// Stage → Edge Function name
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

// Stage → expected pipeline_status when this stage should run
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

interface PipelineMessage {
  doc_id: string;
  stage: string;
  attempt: number;
}

interface QueueMessage {
  msg_id: number;
  message: PipelineMessage;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let maxMessages = DEFAULT_MAX_MESSAGES;
    try {
      const body = await req.json();
      maxMessages = body.max_messages || DEFAULT_MAX_MESSAGES;
    } catch { /* no body */ }

    let processed = 0;
    let failed = 0;
    let skipped = 0;
    let deferred = 0;
    let totalRead = 0;
    let totalDeduped = 0;
    let cycles = 0;
    let dynamicQty = Math.max(MIN_QTY, Math.min(MAX_QTY, maxMessages));
    let dynamicConcurrency = CONCURRENCY_LIMIT;
    const results: Array<{ doc_id: string; stage: string; status: string }> = [];

    // Process messages in parallel with concurrency limit
    // deno-lint-ignore no-inner-declarations
    async function processMessage(msg: QueueMessage): Promise<{ doc_id: string; stage: string; status: string }> {
      const { doc_id, stage, attempt } = msg.message;
      const functionName = STAGE_FUNCTION[stage];
      const started = Date.now();

      if (!functionName) {
        console.error(`Unknown stage: ${stage}`);
        await supabase.rpc("pgmq_archive", { queue_name: "pipeline_jobs", msg_id: msg.msg_id });
        return { doc_id, stage, status: "unknown_stage" };
      }

      const { data: pausedData } = await supabase.rpc("pipeline_stage_is_paused", {
        p_stage: stage,
      });
      if (pausedData === true) {
        await supabase.rpc("pipeline_record_stage_metric", {
          p_document_id: doc_id,
          p_stage: stage,
          p_status: "deferred",
          p_attempt: attempt,
          p_duration_ms: Date.now() - started,
          p_error_message: "stage_paused",
        });
        return { doc_id, stage, status: "deferred" };
      }

      // Idempotency check: verify doc is in the expected status for this stage
      const expectedStatus = STAGE_EXPECTED_STATUS[stage];
      if (expectedStatus) {
        const { data: doc } = await supabase
          .from("documents")
          .select("pipeline_status")
          .eq("id", doc_id)
          .single();

        if (!doc || doc.pipeline_status !== expectedStatus) {
          console.log(`Skipping: doc=${doc_id}, stage=${stage} — status is ${doc?.pipeline_status}, expected ${expectedStatus}`);
          await supabase.rpc("pgmq_archive", { queue_name: "pipeline_jobs", msg_id: msg.msg_id });
          await supabase.rpc("pipeline_record_stage_metric", {
            p_document_id: doc_id,
            p_stage: stage,
            p_status: "skipped",
            p_attempt: attempt,
            p_duration_ms: Date.now() - started,
            p_error_message: `expected_${expectedStatus}_got_${doc?.pipeline_status ?? "null"}`,
          });
          return { doc_id, stage, status: "skipped" };
        }
      }

      try {
        console.log(`Processing: doc=${doc_id}, stage=${stage}, attempt=${attempt}`);

        const resp = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ document_id: doc_id }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`${functionName} returned ${resp.status}: ${errText.slice(0, 200)}`);
        }

        await resp.json();
        console.log(`Stage ${stage} done for doc ${doc_id}`);

        // Archive — next stage enqueued by DB trigger
        await supabase.rpc("pgmq_archive", { queue_name: "pipeline_jobs", msg_id: msg.msg_id });

        // For VERACITY: re-enqueue if doc still has unscored claims (incremental processing)
        if (stage === "VERACITY") {
          const { data: remaining } = await supabase
            .from("claims")
            .select("id")
            .eq("document_id", doc_id)
            .is("veracity_label", null)
            .limit(1);

          const { data: docCheck } = await supabase
            .from("documents")
            .select("pipeline_status")
            .eq("id", doc_id)
            .single();

          if (remaining && remaining.length > 0 && docCheck?.pipeline_status === "verifying") {
            await supabase.rpc("pgmq_send", {
              queue_name: "pipeline_jobs",
              msg: { doc_id, stage: "VERACITY", attempt: 1 },
            });
            console.log(`Re-enqueued VERACITY for doc ${doc_id} (more unscored claims)`);
          }
        }

        await supabase.rpc("pipeline_record_stage_metric", {
          p_document_id: doc_id,
          p_stage: stage,
          p_status: "ok",
          p_attempt: attempt,
          p_duration_ms: Date.now() - started,
          p_error_message: null,
        });
        await supabase.rpc("pipeline_stage_mark_success", { p_stage: stage });

        return { doc_id, stage, status: "ok" };
      } catch (e) {
        const errMessage = e instanceof Error ? e.message : String(e);
        console.error(`Stage ${stage} failed for doc ${doc_id}:`, errMessage);

        await supabase.rpc("pgmq_archive", { queue_name: "pipeline_jobs", msg_id: msg.msg_id });

        await supabase.rpc("pipeline_record_stage_metric", {
          p_document_id: doc_id,
          p_stage: stage,
          p_status: "failed",
          p_attempt: attempt,
          p_duration_ms: Date.now() - started,
          p_error_message: errMessage,
        });
        await supabase.rpc("pipeline_stage_mark_failure", {
          p_stage: stage,
          p_reason: errMessage,
        });

        const stageMaxAttempts = STAGE_MAX_ATTEMPTS[stage] ?? MAX_ATTEMPTS;
        if (attempt < stageMaxAttempts) {
          await supabase.rpc("pgmq_send", {
            queue_name: "pipeline_jobs",
            msg: { doc_id, stage, attempt: attempt + 1 },
          });
          console.log(`Retrying: doc=${doc_id}, stage=${stage}, attempt=${attempt + 1}`);
        } else {
          await supabase.from("pipeline_dlq").insert({
            doc_id,
            stage,
            attempt,
            error_message: errMessage,
            payload: msg.message,
          });
          console.log(`DLQ: doc=${doc_id}, stage=${stage} after ${attempt} attempts`);
        }

        return { doc_id, stage, status: "failed" };
      }
    }

    for (let cycle = 0; cycle < MAX_DRAIN_CYCLES; cycle++) {
      cycles = cycle + 1;

      const { data: messages, error: popErr } = await supabase.rpc("pgmq_read", {
        queue_name: "pipeline_jobs",
        vt: VISIBILITY_TIMEOUT_S,
        qty: dynamicQty,
      });

      if (popErr) {
        console.error("pgmq_read error:", popErr);
        return new Response(
          JSON.stringify({ processed, failed, skipped, error: popErr.message, cycles }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const msgs: QueueMessage[] = (messages || []).map((m: any) => ({
        msg_id: m.msg_id,
        message: m.message as PipelineMessage,
      }));

      if (msgs.length === 0) {
        break;
      }

      totalRead += msgs.length;

      // Deduplicate: only process one message per doc_id+stage (archive extras)
      const seen = new Set<string>();
      const deduped: QueueMessage[] = [];
      const archivePromises: Promise<any>[] = [];
      for (const msg of msgs) {
        const key = `${msg.message.doc_id}:${msg.message.stage}`;
        if (seen.has(key)) {
          archivePromises.push(
            supabase.rpc("pgmq_archive", { queue_name: "pipeline_jobs", msg_id: msg.msg_id }) as Promise<any>
          );
          continue;
        }
        seen.add(key);
        deduped.push(msg);
      }

      totalDeduped += deduped.length;

      if (archivePromises.length > 0) {
        await Promise.allSettled(archivePromises);
      }

      let cycleProcessed = 0;
      let cycleFailed = 0;
      let cycleDeferred = 0;

      // Process in batches of adaptive concurrency
      for (let i = 0; i < deduped.length; i += dynamicConcurrency) {
        const batch = deduped.slice(i, i + dynamicConcurrency);
        const batchResults = await Promise.allSettled(batch.map(processMessage));

        for (const result of batchResults) {
          if (result.status === "fulfilled") {
            const r = result.value;
            results.push(r);
            if (r.status === "ok") {
              processed++;
              cycleProcessed++;
            } else if (r.status === "failed") {
              failed++;
              cycleFailed++;
            } else if (r.status === "deferred") {
              deferred++;
              cycleDeferred++;
            } else if (r.status === "skipped") {
              skipped++;
            }
          } else {
            failed++;
            cycleFailed++;
            console.error("Unexpected parallel error:", result.reason);
          }
        }
      }

      const cycleTotal = Math.max(1, cycleProcessed + cycleFailed + cycleDeferred);
      const failureRatio = cycleFailed / cycleTotal;

      if (failureRatio > 0.2) {
        dynamicQty = Math.max(MIN_QTY, Math.floor(dynamicQty * 0.7));
        dynamicConcurrency = Math.max(MIN_CONCURRENCY, dynamicConcurrency - 1);
      } else if (msgs.length >= dynamicQty && cycleFailed === 0 && cycleDeferred === 0) {
        dynamicQty = Math.min(MAX_QTY, dynamicQty + 10);
        dynamicConcurrency = Math.min(MAX_CONCURRENCY, dynamicConcurrency + 1);
      }
    }

    return new Response(
      JSON.stringify({
        processed,
        failed,
        skipped,
        deferred,
        total_read: totalRead,
        deduped: totalDeduped,
        cycles,
        final_qty: dynamicQty,
        final_concurrency: dynamicConcurrency,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Pipeline worker fatal:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});