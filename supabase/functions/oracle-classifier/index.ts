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

  try {
    const { systemPrompt, config } = compilePrompt("classifier", classifierTemplate);
    const { content } = await callLlm({
      gateway: config.gateway,
      model: config.model,
      systemPrompt,
      userPrompt,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      apiKey,
    });

    const parsed: ClassificationResult[] = JSON.parse(content);

    if (Array.isArray(parsed) && parsed.length === segments.length) {
      for (let i = 0; i < segments.length; i++) {
        const result = parsed[i];
        // Validate classification
        const validClasses = ["FACTUAL_CLAIM", "OPINION_ANALYSIS", "PROCEDURAL", "OTHER"];
        if (!validClasses.includes(result.classification)) {
          result.classification = "OTHER";
        }
        // Apply rhetorical overrides
        if (result.rhetorical_flags?.is_sarcastic || result.rhetorical_flags?.is_rhetorical_question) {
          result.classification = "OPINION_ANALYSIS";
        }
        // Ensure flags exist
        result.rhetorical_flags = {
          is_sarcastic: result.rhetorical_flags?.is_sarcastic || false,
          is_hypothetical: result.rhetorical_flags?.is_hypothetical || false,
          is_rhetorical_question: result.rhetorical_flags?.is_rhetorical_question || false,
          is_quotation: result.rhetorical_flags?.is_quotation || false,
        };
        results.set(segments[i].id, result);
      }
    } else {
      console.error(`Expected ${segments.length} results, got ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
    }
  } catch (e) {
    console.error("Classification batch failed:", e);
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

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let documentId: string | null = null;
    let batchSize = 5; // documents per invocation
    let segmentBatchSize = 10; // segments per LLM call
    try {
      const body = await req.json();
      documentId = body.document_id || null;
      batchSize = body.batch_size || 5;
      segmentBatchSize = body.segment_batch_size || 10;
    } catch {
      // No body — process all ready documents
    }

    // Find documents ready for classification
    let query = supabase
      .from("documents")
      .select("id")
      .eq("pipeline_status", "classifying")
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
        JSON.stringify({ classified: 0, message: "No documents to classify" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalClassified = 0;
    let totalFactual = 0;
    let totalOpinion = 0;
    let totalProcedural = 0;
    let totalOther = 0;
    const errors: string[] = [];

    for (const doc of docs) {
      try {
        // Get unclassified segments for this document
        const { data: segments, error: segErr } = await supabase
          .from("segments")
          .select("id, text_content, position_index")
          .eq("document_id", doc.id)
          .is("classification", null)
          .order("position_index", { ascending: true });

        if (segErr) throw segErr;
        if (!segments || segments.length === 0) {
          // All segments already classified — move forward
          await supabase
            .from("documents")
            .update({ pipeline_status: "extracting" })
            .eq("id", doc.id);
          continue;
        }

        // Process in batches
        for (let i = 0; i < segments.length; i += segmentBatchSize) {
          const batch = segments.slice(i, i + segmentBatchSize);
          const batchInput = batch.map((s) => ({
            id: s.id,
            // Strip watermark comment from text for classification
            text: s.text_content.replace(/\n\n<!-- corpus-watermark:[^>]+-->/g, ""),
            position: s.position_index,
          }));

          const classifications = await classifyBatch(batchInput, openrouterKey);

          // Batch update segments
          const updateRows: { id: string; classification: string; rhetorical_flags: any; label: string | null }[] = [];
          for (const seg of batch) {
            const result = classifications.get(seg.id);
            if (!result) {
              errors.push(`Segment ${seg.id}: no classification returned`);
              continue;
            }
            updateRows.push({
              id: seg.id,
              classification: result.classification,
              rhetorical_flags: result.rhetorical_flags,
              label: classificationToLabel(result.classification),
            });
            totalClassified++;
            switch (result.classification) {
              case "FACTUAL_CLAIM": totalFactual++; break;
              case "OPINION_ANALYSIS": totalOpinion++; break;
              case "PROCEDURAL": totalProcedural++; break;
              case "OTHER": totalOther++; break;
            }
          }

          // Update all segments in parallel
          const updatePromises = updateRows.map((row) =>
            supabase
              .from("segments")
              .update({
                classification: row.classification,
                rhetorical_flags: row.rhetorical_flags,
                label: row.label,
              })
              .eq("id", row.id)
          );
          const updateResults = await Promise.allSettled(updatePromises);
          for (const r of updateResults) {
            if (r.status === "rejected") {
              errors.push(`Segment update: ${r.reason}`);
            }
          }
        }

        // Move document to next pipeline stage
        await supabase
          .from("documents")
          .update({ pipeline_status: "extracting" })
          .eq("id", doc.id);
      } catch (e) {
        errors.push(`Doc ${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
        await supabase
          .from("documents")
          .update({ pipeline_status: "failed" })
          .eq("id", doc.id);
      }
    }

    console.log(
      `Classifier complete: ${totalClassified} segments (${totalFactual} factual, ${totalOpinion} opinion, ${totalProcedural} procedural, ${totalOther} other)`
    );
    if (errors.length) console.warn("Classifier errors:", errors);

    return new Response(
      JSON.stringify({
        documents: docs.length,
        classified: totalClassified,
        breakdown: {
          factual_claim: totalFactual,
          opinion_analysis: totalOpinion,
          procedural: totalProcedural,
          other: totalOther,
        },
        errors: errors.length ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Classifier fatal error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
