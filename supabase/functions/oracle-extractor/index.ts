import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { compilePrompt } from "../_shared/prompt-builder.ts";
import { callLlm } from "../_shared/llm-client.ts";
import { extractorTemplate, buildExtractorUserPrompt } from "../_shared/prompts/extractor.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LLM_TIMEOUT_MS = 60_000;

// --------------- Risk classification ---------------

// High-risk keyword patterns that require elevated evidence thresholds
const CRITICAL_RISK_PATTERNS = [
  /\b(killed|assassinated|died|dead|death)\b.*\b(president|prime minister|supreme leader|head of state|king|queen|pope|chancellor)\b/i,
  /\b(president|prime minister|supreme leader|head of state|king|queen|pope|chancellor)\b.*\b(killed|assassinated|died|dead|death)\b/i,
  /\b(nuclear|chemical|biological)\s+(attack|strike|weapon|bomb|warhead)\b/i,
  /\b(declaration\s+of\s+war|declared\s+war|war\s+declared)\b/i,
  /\b(coup\s+d'[eé]tat|military\s+coup|government\s+overthrown)\b/i,
  /\b(martial\s+law\s+declared|state\s+of\s+emergency)\b/i,
];

const HIGH_RISK_PATTERNS = [
  /\b(terrorist|terror)\s+(attack|incident|bombing|shooting)\b/i,
  /\b(mass\s+(shooting|casualty|casualties|killing))\b/i,
  /\b(genocide|ethnic\s+cleansing|war\s+crime)\b/i,
  /\b(invasion|invaded|invading)\b.*\b(country|nation|territory)\b/i,
  /\b(sanctions|embargo)\s+(imposed|announced|declared)\b/i,
  /\b(arrested|indicted|convicted)\b.*\b(president|minister|senator|governor|ceo)\b/i,
  /\b(president|minister|senator|governor|ceo)\b.*\b(arrested|indicted|convicted)\b/i,
  /\b(market\s+crash|economic\s+collapse|bank\s+failure)\b/i,
  /\b(pandemic|epidemic)\s+(declared|announced)\b/i,
];

const MEDIUM_RISK_PATTERNS = [
  /\b(illegal|unlawful|prohibited|banned)\b/i,
  /\b(statute|regulation|law\s+requires|legally\s+required)\b/i,
  /\b(under\s+investigation|being\s+investigated|probe)\b/i,
  /\b(millions|billions|trillions)\s+(of\s+)?(dollars|euros|pounds)\b/i,
  /\b\$\d{1,3}(,\d{3})*\s*(million|billion|trillion)\b/i,
];

function classifyClaimRisk(claimText: string): string {
  for (const pattern of CRITICAL_RISK_PATTERNS) {
    if (pattern.test(claimText)) return "CRITICAL";
  }
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(claimText)) return "HIGH";
  }
  for (const pattern of MEDIUM_RISK_PATTERNS) {
    if (pattern.test(claimText)) return "MEDIUM";
  }
  return "LOW";
}

// --------------- Attribution detection ---------------

const ATTRIBUTION_PATTERNS = [
  /\b(?:said|stated|wrote|tweeted|posted|announced|declared|claimed|told|testified)\b/i,
  /\baccording\s+to\b/i,
  /\b(?:in\s+a\s+(?:statement|tweet|post|speech|interview|press\s+conference))\b/i,
  /\b(?:quoted\s+as\s+saying)\b/i,
];

function isAttributionClaim(claimText: string): boolean {
  return ATTRIBUTION_PATTERNS.some(p => p.test(claimText));
}

// --------------- Types ---------------

interface ExtractedClaim {
  claim_text: string;
  sire_scope: {
    entities: string[];
    topics: string[];
    temporal_scope: string | null;
  };
  sire_information: {
    time_qualifier: string | null;
    geography: string | null;
    conditions: string | null;
    quantifiers: string | null;
  };
  sire_retrieval: {
    search_queries: string[];
    evidence_tiers: string[];
    time_window: string | null;
  };
  sire_exclusions: {
    is_checkable: boolean;
    exclusion_reasons: string[];
  };
}

// --------------- Extraction via Sonar ---------------

async function extractClaims(
  segments: { id: string; text: string; position: number; rhetorical_flags: Record<string, boolean> | null }[],
  apiKey: string
): Promise<Map<string, ExtractedClaim[]>> {
  const results = new Map<string, ExtractedClaim[]>();

  const userPrompt = buildExtractorUserPrompt(
    segments.map((s) => {
      const flags = s.rhetorical_flags
        ? Object.entries(s.rhetorical_flags)
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(", ")
        : "none";
      return { text: s.text, position: s.position, flags };
    })
  );

  const { systemPrompt, config } = compilePrompt("extractor", extractorTemplate);

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
      throw new Error(`LLM extraction timed out after ${LLM_TIMEOUT_MS}ms`);
    }
    throw e;
  }

  const parsed = JSON.parse(content);

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array of extraction results, got ${typeof parsed}`);
  }

  for (const item of parsed) {
    const segIndex = item.segment_index;
    const claims: ExtractedClaim[] = item.claims || [];

    if (segIndex !== undefined && segIndex >= 0 && segIndex < segments.length) {
      const segId = segments[segIndex].id;
      const validated = claims
        .filter((c: ExtractedClaim) => c.claim_text && c.claim_text.length > 10)
        .map((c: ExtractedClaim) => ({
          claim_text: c.claim_text,
          sire_scope: {
            entities: c.sire_scope?.entities || [],
            topics: c.sire_scope?.topics || [],
            temporal_scope: c.sire_scope?.temporal_scope || null,
          },
          sire_information: {
            time_qualifier: c.sire_information?.time_qualifier || null,
            geography: c.sire_information?.geography || null,
            conditions: c.sire_information?.conditions || null,
            quantifiers: c.sire_information?.quantifiers || null,
          },
          sire_retrieval: {
            search_queries: c.sire_retrieval?.search_queries || [],
            evidence_tiers: c.sire_retrieval?.evidence_tiers || ["T3_reference", "T5_corpus"],
            time_window: c.sire_retrieval?.time_window || null,
          },
          sire_exclusions: {
            is_checkable: c.sire_exclusions?.is_checkable !== false,
            exclusion_reasons: c.sire_exclusions?.exclusion_reasons || [],
          },
        }));
      results.set(segId, validated);
    }
  }

  return results;
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

    // Idempotency: only process if still in extracting state
    const { data: doc, error: fetchErr } = await supabase
      .from("documents")
      .select("id")
      .eq("id", documentId)
      .eq("pipeline_status", "extracting")
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!doc) {
      return json({ skipped: true, message: "Document not in extracting state (already processed or missing)" });
    }

    // Get FACTUAL_CLAIM segments
    const { data: segments, error: segErr } = await supabase
      .from("segments")
      .select("id, text_content, position_index, rhetorical_flags")
      .eq("document_id", doc.id)
      .eq("classification", "FACTUAL_CLAIM")
      .order("position_index", { ascending: true });

    if (segErr) throw segErr;
    if (!segments || segments.length === 0) {
      // No factual segments — advance
      const { data: updated } = await supabase
        .from("documents")
        .update({ pipeline_status: "verifying" })
        .eq("id", doc.id)
        .eq("pipeline_status", "extracting")
        .select("id")
        .maybeSingle();
      return json({ extracted: 0, advanced: !!updated, message: "No factual segments to extract" });
    }

    // Filter to segments without claims yet (idempotent on retry)
    const segIds = segments.map((s) => s.id);
    const { data: existingClaims } = await supabase
      .from("claims")
      .select("segment_id")
      .in("segment_id", segIds);

    const alreadyExtracted = new Set((existingClaims || []).map((c) => c.segment_id));
    const toProcess = segments.filter((s) => !alreadyExtracted.has(s.id));

    if (toProcess.length === 0) {
      const { data: updated } = await supabase
        .from("documents")
        .update({ pipeline_status: "verifying" })
        .eq("id", doc.id)
        .eq("pipeline_status", "extracting")
        .select("id")
        .maybeSingle();
      return json({ extracted: 0, advanced: !!updated, message: "All segments already extracted" });
    }

    let totalClaims = 0;
    let totalCheckable = 0;
    let totalNotCheckable = 0;
    const riskCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    const SEGMENT_BATCH_SIZE = 8;

    // Process in batches
    for (let i = 0; i < toProcess.length; i += SEGMENT_BATCH_SIZE) {
      const batch = toProcess.slice(i, i + SEGMENT_BATCH_SIZE);
      const batchInput = batch.map((s) => ({
        id: s.id,
        text: s.text_content.replace(/\n\n<!-- corpus-watermark:[^>]+-->/g, ""),
        position: s.position_index,
        rhetorical_flags: s.rhetorical_flags as Record<string, boolean> | null,
      }));

      const extracted = await extractClaims(batchInput, openrouterKey);

      // Insert claims into database
      for (const [segmentId, claims] of extracted) {
        for (const claim of claims) {
          const isCheckable = claim.sire_exclusions.is_checkable;
          const riskLevel = classifyClaimRisk(claim.claim_text);
          const isAttribution = isAttributionClaim(claim.claim_text);
          riskCounts[riskLevel as keyof typeof riskCounts]++;

          const claimType = (claim.sire_retrieval as any)?.claim_type || "DIRECT";
          const claimInsert: Record<string, unknown> = {
            segment_id: segmentId,
            document_id: doc.id,
            claim_text: claim.claim_text,
            sire_scope: claim.sire_scope,
            sire_information: claim.sire_information,
            sire_retrieval: {
              ...claim.sire_retrieval,
              is_attribution: isAttribution || claimType === "ATTRIBUTION",
              claim_type: claimType,
            },
            sire_exclusions: claim.sire_exclusions,
            veracity_label: isCheckable ? null : "NOT_CHECKABLE",
            confidence_score: isCheckable ? null : 1.0,
            risk_level: riskLevel,
          };

          const { error: insertErr } = await supabase.from("claims").insert(claimInsert);
          if (insertErr) throw insertErr;

          totalClaims++;
          if (isCheckable) totalCheckable++;
          else totalNotCheckable++;
        }

        // Update segment label for non-checkable if ALL claims are not checkable
        if (claims.length > 0 && claims.every((c) => !c.sire_exclusions.is_checkable)) {
          await supabase
            .from("segments")
            .update({ label: "NOT_CHECKABLE" })
            .eq("id", segmentId);
        }
      }
    }

    // Advance pipeline — idempotency guard
    const { data: updated, error: updateErr } = await supabase
      .from("documents")
      .update({ pipeline_status: "verifying" })
      .eq("id", doc.id)
      .eq("pipeline_status", "extracting")
      .select("id")
      .maybeSingle();

    if (updateErr) throw updateErr;
    if (!updated) {
      return json({ skipped: true, message: "Document status changed during processing (race)" });
    }

    console.log(
      `Extractor done: ${doc.id} — ${totalClaims} claims (${totalCheckable} checkable, ${totalNotCheckable} not checkable) | Risk: C=${riskCounts.CRITICAL} H=${riskCounts.HIGH} M=${riskCounts.MEDIUM} L=${riskCounts.LOW}`
    );
    return json({
      extracted: totalClaims,
      id: doc.id,
      checkable: totalCheckable,
      not_checkable: totalNotCheckable,
      risk_breakdown: riskCounts,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Extractor error:", msg);
    return json({ error: msg }, 500);
  }
});
