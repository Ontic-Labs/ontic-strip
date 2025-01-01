declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

// @ts-ignore: Deno remote URL import is resolved at edge runtime
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// @ts-ignore: Deno remote URL import is resolved at edge runtime
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { compilePrompt } from "../_shared/prompt-builder.ts";
import { callLlm } from "../_shared/llm-client.ts";
import { synthesisTemplate, buildSynthesisUserPrompt } from "../_shared/prompts/synthesis.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type SynthesisRequestBody = {
  document_id?: string;
  batch_size?: number;
};

function getRequiredEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = getRequiredEnv("SUPABASE_URL");
    const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const openrouterKey = getRequiredEnv("OPENROUTER_API_KEY");
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let documentId: string | null = null;
    let batchSize = 5;
    try {
      const body = await req.json() as SynthesisRequestBody;
      documentId = body.document_id ?? null;
      batchSize = Number.isInteger(body.batch_size) && (body.batch_size as number) > 0
        ? (body.batch_size as number)
        : 5;
    } catch { /* no body */ }

    // Find documents that are aggregated and have scores but no synthesis
    let query = supabase
      .from("documents")
      .select("id, title, grounding_score, integrity_score, sentiment_compound, sentiment_pos, sentiment_neg, sentiment_neu, strip")
      .eq("pipeline_status", "aggregated")
      .is("synthesis_text", null)
      .not("grounding_score", "is", null)
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (documentId) {
      query = supabase
        .from("documents")
        .select("id, title, grounding_score, integrity_score, sentiment_compound, sentiment_pos, sentiment_neg, sentiment_neu, strip")
        .eq("id", documentId)
        .limit(1);
    }

    const { data: docs, error: docsErr } = await query;
    if (docsErr) throw docsErr;
    if (!docs || docs.length === 0) {
      return new Response(
        JSON.stringify({ synthesized: 0, message: "No documents need synthesis" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalSynthesized = 0;
    const errors: string[] = [];

    for (const doc of docs) {
      try {
        // Get claims summary
        const { data: claims } = await supabase
          .from("claims")
          .select("veracity_label, confidence_score")
          .eq("document_id", doc.id);

        const claimSummary: Record<string, number> = {};
        for (const c of claims || []) {
          const label = c.veracity_label || "UNKNOWN";
          claimSummary[label] = (claimSummary[label] || 0) + 1;
        }

        // Get strip distribution
        const strip = (doc.strip as Array<{ label: string }>) || [];
        const stripDist: Record<string, number> = {};
        for (const cell of strip) {
          stripDist[cell.label] = (stripDist[cell.label] || 0) + 1;
        }

        const userPrompt = buildSynthesisUserPrompt({
          title: doc.title || "Untitled",
          groundingScore: doc.grounding_score,
          integrityScore: doc.integrity_score,
          sentimentCompound: doc.sentiment_compound,
          sentimentPos: doc.sentiment_pos,
          sentimentNeg: doc.sentiment_neg,
          sentimentNeu: doc.sentiment_neu,
          totalClaims: claims?.length || 0,
          claimVerdicts: claimSummary,
          stripLength: strip.length,
          stripDistribution: stripDist,
        });

        const { systemPrompt, config } = compilePrompt("synthesis", synthesisTemplate);
        const llmResult = await callLlm({
          gateway: config.gateway,
          model: config.model,
          systemPrompt,
          userPrompt,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          apiKey: openrouterKey,
        });

        const synthesis = llmResult.content;
        const citations = llmResult.citations || [];

        if (synthesis) {
          const { error: updateErr } = await supabase
            .from("documents")
            .update({ 
              synthesis_text: synthesis,
              synthesis_sources: citations,
            })
            .eq("id", doc.id);

          if (updateErr) {
            errors.push(`Doc ${doc.id}: update failed: ${updateErr.message}`);
          } else {
            totalSynthesized++;
            console.log(`Doc ${doc.id}: synthesis generated (${synthesis.length} chars)`);
          }
        }
      } catch (e) {
        errors.push(`Doc ${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return new Response(
      JSON.stringify({ synthesized: totalSynthesized, errors: errors.length ? errors : undefined }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("oracle-synthesis fatal:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
