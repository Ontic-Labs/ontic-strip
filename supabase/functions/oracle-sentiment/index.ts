import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { compilePrompt } from "../_shared/prompt-builder.ts";
import { callLlm } from "../_shared/llm-client.ts";
import { sentimentTemplate, buildSentimentUserPrompt } from "../_shared/prompts/sentiment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const BATCH_SIZE = 10;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openrouterApiKey = Deno.env.get("OPENROUTER_API_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let documentId: string | null = null;
    let batchSize = 5;
    try {
      const body = await req.json();
      documentId = body.document_id || null;
      batchSize = body.batch_size || 5;
    } catch { /* no body */ }

    // Find documents needing sentiment
    let query = supabase
      .from("documents")
      .select("id")
      .eq("pipeline_status", "aggregated")
      .is("sentiment_compound", null)
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (documentId) {
      query = supabase
        .from("documents")
        .select("id")
        .eq("id", documentId)
        .limit(1);
    }

    const { data: docs, error: docsErr } = await query;
    if (docsErr) throw docsErr;
    if (!docs || docs.length === 0) {
      return new Response(
        JSON.stringify({ scored: 0, message: "No documents need sentiment scoring" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalScored = 0;
    const errors: string[] = [];

    for (const doc of docs) {
      try {
        const { data: segments, error: segErr } = await supabase
          .from("segments")
          .select("id, text_content, position_index")
          .eq("document_id", doc.id)
          .order("position_index", { ascending: true });

        if (segErr) throw segErr;
        if (!segments || segments.length === 0) continue;

        // Process in batches of BATCH_SIZE
        for (let i = 0; i < segments.length; i += BATCH_SIZE) {
          const batch = segments.slice(i, i + BATCH_SIZE);
          const userPrompt = buildSentimentUserPrompt(
            batch.map((s, idx) => ({
              index: idx,
              text: s.text_content.replace(/<!--[\s\S]*?-->/g, "").trim(),
            }))
          );

          let scores: Array<{ compound: number; pos: number; neg: number; neu: number }>;
          try {
            const { systemPrompt, config } = compilePrompt("sentiment", sentimentTemplate);
            const { content } = await callLlm({
              gateway: config.gateway,
              model: config.model,
              systemPrompt,
              userPrompt,
              temperature: config.temperature,
              maxTokens: config.maxTokens,
              apiKey: openrouterApiKey,
            });
            scores = JSON.parse(content);
          } catch (err) {
            errors.push(`Doc ${doc.id} batch ${i}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          // Update segments in parallel
          const segUpdates = [];
          for (let j = 0; j < batch.length && j < scores.length; j++) {
            const s = scores[j];
            segUpdates.push(
              supabase
                .from("segments")
                .update({
                  sentiment_compound: Math.round(s.compound * 1000) / 1000,
                  sentiment_pos: Math.round(s.pos * 1000) / 1000,
                  sentiment_neg: Math.round(s.neg * 1000) / 1000,
                  sentiment_neu: Math.round(s.neu * 1000) / 1000,
                })
                .eq("id", batch[j].id)
            );
          }
          const segResults = await Promise.allSettled(segUpdates);
          for (const r of segResults) {
            if (r.status === "fulfilled" && r.value.error) {
              errors.push(`Segment update: ${r.value.error.message}`);
            }
          }
        }

        // Compute document-level averages
        const { data: scoredSegs } = await supabase
          .from("segments")
          .select("sentiment_compound, sentiment_pos, sentiment_neg, sentiment_neu")
          .eq("document_id", doc.id)
          .not("sentiment_compound", "is", null);

        if (scoredSegs && scoredSegs.length > 0) {
          const n = scoredSegs.length;
          const avg = (key: string) =>
            Math.round((scoredSegs.reduce((s, r) => s + ((r as any)[key] || 0), 0) / n) * 1000) / 1000;

          const { error: docErr } = await supabase
            .from("documents")
            .update({
              sentiment_compound: avg("sentiment_compound"),
              sentiment_pos: avg("sentiment_pos"),
              sentiment_neg: avg("sentiment_neg"),
              sentiment_neu: avg("sentiment_neu"),
            })
            .eq("id", doc.id);

          if (docErr) errors.push(`Doc ${doc.id} avg update: ${docErr.message}`);
          else totalScored++;
          
          console.log(`Doc ${doc.id}: sentiment scored ${scoredSegs.length} segments, compound=${avg("sentiment_compound")}`);
        }
      } catch (e) {
        errors.push(`Doc ${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return new Response(
      JSON.stringify({ scored: totalScored, errors: errors.length ? errors : undefined }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("oracle-sentiment fatal:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
