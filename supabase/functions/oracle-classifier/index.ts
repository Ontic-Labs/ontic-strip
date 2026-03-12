import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { compilePrompt } from "../_shared/prompt-builder.ts";
import { callLlm } from "../_shared/llm-client.ts";
import { classifierTemplate, buildClassifierUserPrompt } from "../_shared/prompts/classifier.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LLM_TIMEOUT_MS = 60_000;

// --------------- Batch Classification ---------------

interface ClassificationResult {
  classification: string;
  rhetorical_flags: {
    is_sarcastic: boolean;
    is_hypothetical: boolean;
    is_rhetorical_question: boolean;
    is_quotation: boolean;
  };
}

async function classifyBatch(
  segments: { id: string; text: string; position: number }[],
  apiKey: string
): Promise<Map<string, ClassificationResult>> {
  const results = new Map<string, ClassificationResult>();

  const userPrompt = buildClassifierUserPrompt(
    segments.map((s) => ({ text: s.text, position: s.position }))
  );

  const { systemPrompt, config } = compilePrompt("classifier", classifierTemplate);

  let content: string;
  try {
    ({ content } = await callLlm({
      gateway: config.gateway,
      model: config.model,
      systemPrompt,
      userPrompt,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      apiKey,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    }));
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`LLM classification timed out after ${LLM_TIMEOUT_MS}ms`);
    }
    throw e;
  }

  const parsed: ClassificationResult[] = JSON.parse(content);

  if (!Array.isArray(parsed) || parsed.length !== segments.length) {
    throw new Error(`Expected ${segments.length} classification results, got ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
  }

  for (let i = 0; i < segments.length; i++) {
    const result = parsed[i];
    const validClasses = ["FACTUAL_CLAIM", "OPINION_ANALYSIS", "PROCEDURAL", "OTHER"];
    if (!validClasses.includes(result.classification)) {
      result.classification = "OTHER";
    }
    if (result.rhetorical_flags?.is_sarcastic || result.rhetorical_flags?.is_rhetorical_question) {
      result.classification = "OPINION_ANALYSIS";
    }
    result.rhetorical_flags = {
      is_sarcastic: result.rhetorical_flags?.is_sarcastic || false,
      is_hypothetical: result.rhetorical_flags?.is_hypothetical || false,
      is_rhetorical_question: result.rhetorical_flags?.is_rhetorical_question || false,
      is_quotation: result.rhetorical_flags?.is_quotation || false,
    };
    results.set(segments[i].id, result);
  }

  return results;
}

// --------------- Segment Label from Classification ---------------

function classificationToLabel(classification: string): string | null {
  switch (classification) {
    case "OPINION_ANALYSIS":
      return "OPINION";
    case "PROCEDURAL":
      return "NEUTRAL";
    case "OTHER":
      return "OTHER";
    case "FACTUAL_CLAIM":
      return null; // Will be set by veracity scoring later
    default:
      return null;
  }
}

// --------------- Main Handler ---------------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let documentId: string | null = null;
    try {
      const body = await req.json();
      documentId = body.document_id || null;
    } catch {
      // No body
    }

    if (!documentId) {
      return json({ error: "document_id is required" }, 400);
    }

    // Idempotency: only process if still in classifying state
    const { data: doc, error: fetchErr } = await supabase
      .from("documents")
      .select("id")
      .eq("id", documentId)
      .eq("pipeline_status", "classifying")
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!doc) {
      return json({ skipped: true, message: "Document not in classifying state (already processed or missing)" });
    }

    // Get unclassified segments
    const { data: segments, error: segErr } = await supabase
      .from("segments")
      .select("id, text_content, position_index")
      .eq("document_id", doc.id)
      .is("classification", null)
      .order("position_index", { ascending: true });

    if (segErr) throw segErr;
    if (!segments || segments.length === 0) {
      // All segments already classified — advance
      const { data: updated } = await supabase
        .from("documents")
        .update({ pipeline_status: "extracting" })
        .eq("id", doc.id)
        .eq("pipeline_status", "classifying")
        .select("id")
        .maybeSingle();
      return json({ classified: 0, advanced: !!updated, message: "All segments already classified" });
    }

    let totalClassified = 0;
    let totalFactual = 0;
    let totalOpinion = 0;
    let totalProcedural = 0;
    let totalOther = 0;
    const SEGMENT_BATCH_SIZE = 10;

    // Process in batches
    for (let i = 0; i < segments.length; i += SEGMENT_BATCH_SIZE) {
      const batch = segments.slice(i, i + SEGMENT_BATCH_SIZE);
      const batchInput = batch.map((s) => ({
        id: s.id,
        text: s.text_content.replace(/\n\n<!-- corpus-watermark:[^>]+-->/g, ""),
        position: s.position_index,
      }));

      const classifications = await classifyBatch(batchInput, openrouterKey);

      // Update segments
      for (const seg of batch) {
        const result = classifications.get(seg.id);
        if (!result) {
          throw new Error(`Segment ${seg.id}: no classification returned`);
        }
        const { error: updErr } = await supabase
          .from("segments")
          .update({
            classification: result.classification,
            rhetorical_flags: result.rhetorical_flags,
            label: classificationToLabel(result.classification),
          })
          .eq("id", seg.id);
        if (updErr) throw updErr;

        totalClassified++;
        switch (result.classification) {
          case "FACTUAL_CLAIM": totalFactual++; break;
          case "OPINION_ANALYSIS": totalOpinion++; break;
          case "PROCEDURAL": totalProcedural++; break;
          case "OTHER": totalOther++; break;
        }
      }
    }

    // Advance pipeline — idempotency guard
    const { data: updated, error: updateErr } = await supabase
      .from("documents")
      .update({ pipeline_status: "extracting" })
      .eq("id", doc.id)
      .eq("pipeline_status", "classifying")
      .select("id")
      .maybeSingle();

    if (updateErr) throw updateErr;
    if (!updated) {
      return json({ skipped: true, message: "Document status changed during processing (race)" });
    }

    console.log(
      `Classifier done: ${doc.id} — ${totalClassified} segments (${totalFactual} factual, ${totalOpinion} opinion, ${totalProcedural} procedural, ${totalOther} other)`
    );
    return json({
      classified: totalClassified,
      id: doc.id,
      breakdown: { factual_claim: totalFactual, opinion_analysis: totalOpinion, procedural: totalProcedural, other: totalOther },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Classifier error:", msg);
    return json({ error: msg }, 500);
  }
});
