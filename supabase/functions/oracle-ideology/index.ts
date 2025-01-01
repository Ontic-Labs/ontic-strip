// =============================================================
// Oracle Ideology v2 — Proposition-Based IRT Scoring
// RAG retrieval → stance extraction → MAP θ estimation
// =============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { compilePrompt } from "../_shared/prompt-builder.ts";
import { callLlm } from "../_shared/llm-client.ts";
import { stanceTemplate, buildStanceUserPrompt } from "../_shared/prompts/stance.ts";
import { computeIdeologyMap, type StanceVote } from "../_shared/ideology-irt.ts";
import {
  PROP_TOP_K_FINAL,
  PROP_SIM_THRESHOLD,
  PROP_SIM_THRESHOLD_NO_KEYWORDS,
  CROSS_DOMAIN_PENALTY,
  KEYWORD_BOOST,
  STANCE_CONFIDENCE_UNCLEAR,
  STANCE_MIN_SEGMENT_TOKENS,
  IDEOLOGY_SCORING_VERSION,
  IRT_MIN_STANCES,
  DOMAIN_CAP_FRACTION,
} from "../_shared/ideology-constants.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Proposition {
  proposition_id: string;
  text: string;
  keywords: string[];
  domain: string;
  dimension: string;
  liberal_is_pro: boolean;
  discrimination_a: number;
  difficulty_b: number;
  embedding: string;
}

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
    try {
      const body = await req.json();
      documentId = body.document_id || null;
    } catch { /* no body */ }

    if (!documentId) {
      return new Response(
        JSON.stringify({ error: "document_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Fetch document segments with embeddings
    const { data: segments, error: segErr } = await supabase
      .from("segments")
      .select("id, text_content, token_count, classification, label, embedding, position_index")
      .eq("document_id", documentId)
      .not("embedding", "is", null)
      .order("position_index", { ascending: true });

    if (segErr) throw segErr;
    if (!segments || segments.length === 0) {
      await writeDocIdeology(supabase, documentId, null);
      return respond({ scored: false, reason: "no_segments_with_embeddings" });
    }

    console.log(`DIAG: ${segments.length} segs, embType=${typeof segments[0]?.embedding}, tokCount=${segments[0]?.token_count}`);
    try {
      const testEmb = segments[0]?.embedding;
      if (testEmb) {
        const p = typeof testEmb === "string" ? JSON.parse(testEmb) : testEmb;
        console.log(`DIAG: embLen=${Array.isArray(p) ? p.length : "notArr"}, first3=${JSON.stringify(p?.slice?.(0,3))}`);
      } else {
        console.log(`DIAG: embedding is falsy: ${testEmb}`);
      }
    } catch (e) { console.log(`DIAG: embed parse err: ${e}`); }

    // 2. Load active propositions
    const { data: propositions, error: propErr } = await supabase
      .from("proposition_bank")
      .select("proposition_id, text, keywords, domain, dimension, liberal_is_pro, discrimination_a, difficulty_b, embedding")
      .eq("status", "active");

    if (propErr) throw propErr;
    if (!propositions || propositions.length === 0) {
      await writeDocIdeology(supabase, documentId, null);
      return respond({ scored: false, reason: "no_propositions" });
    }

    // Pre-parse proposition embeddings
    const propVectors = propositions.map((p: Proposition) => ({
      ...p,
      vec: typeof p.embedding === "string" ? JSON.parse(p.embedding) : p.embedding,
    }));

    const allStanceVotes: StanceVote[] = [];
    let totalStanceExtractions = 0;

    // 3. Retrieval phase: find matched propositions for each segment (no LLM calls)
    const MAX_SEGMENTS_TO_SCORE = 8; // Limit LLM calls within 60s budget
    const segMatches: Array<{
      seg: typeof segments[0];
      matches: Array<Proposition & { adjusted: number }>;
    }> = [];

    for (const seg of segments) {
      if ((seg.token_count || 0) < STANCE_MIN_SEGMENT_TOKENS) continue;

      let segVec: number[];
      try {
        segVec = typeof seg.embedding === "string" ? JSON.parse(seg.embedding) : seg.embedding;
        if (!Array.isArray(segVec) || segVec.length === 0) continue;
      } catch { continue; }

      const scored = propVectors.map((p: Proposition & { vec: number[] }) => {
        const sim = cosineSim(segVec, p.vec);
        const segWords = new Set(seg.text_content.toLowerCase().split(/\W+/));
        const hasOverlap = p.keywords.some((k: string) =>
          k.toLowerCase().split(/\s+/).some((w: string) => segWords.has(w))
        );
        let adjusted = sim;
        const segDomain = classificationToDomain(seg.classification);
        if (segDomain && segDomain !== p.domain) adjusted -= CROSS_DOMAIN_PENALTY;
        if (hasOverlap) adjusted += KEYWORD_BOOST;
        const threshold = hasOverlap ? PROP_SIM_THRESHOLD : PROP_SIM_THRESHOLD_NO_KEYWORDS;
        return { ...p, similarity: sim, adjusted, threshold, hasOverlap };
      });

      const filtered = scored
        .filter((p) => p.adjusted >= p.threshold)
        .sort((a, b) => b.adjusted - a.adjusted)
        .slice(0, PROP_TOP_K_FINAL);

      if (filtered.length > 0) {
        segMatches.push({ seg, matches: filtered });
      }
    }

    // Deterministic selection: sort by best match quality desc, then position asc for tie-breaking
    segMatches.sort((a, b) => {
      const qualityDiff = b.matches[0].adjusted - a.matches[0].adjusted;
      if (Math.abs(qualityDiff) > 0.001) return qualityDiff;
      return (a.seg.position_index ?? 0) - (b.seg.position_index ?? 0);
    });
    const toProcess = segMatches.slice(0, MAX_SEGMENTS_TO_SCORE);

    console.log(`Retrieval done: ${segments.length} segments → ${segMatches.length} with matches → processing top ${toProcess.length}`);

    // 4. Stance extraction phase: process segments with LLM calls
    const { systemPrompt, config } = compilePrompt("stance", stanceTemplate);

    for (const { seg, matches } of toProcess) {
      try {
        const userPrompt = buildStanceUserPrompt(
          seg.text_content,
          matches.map((p) => ({ proposition_id: p.proposition_id, text: p.text }))
        );

        const { content } = await callLlm({
          gateway: config.gateway,
          model: config.model,
          systemPrompt,
          userPrompt,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          apiKey: openrouterApiKey,
        });

        let stances: Array<{
          proposition_id: string;
          stance: string;
          confidence: number;
          quoted_text?: string;
        }>;

        try {
          stances = JSON.parse(content);
          if (!Array.isArray(stances)) stances = [stances];
        } catch {
          console.warn(`Stance parse error for segment ${seg.id}:`, content.slice(0, 200));
          continue;
        }

        for (const s of stances) {
          if (!s.proposition_id || !s.stance || typeof s.confidence !== "number") continue;

          let finalStance = s.stance;
          if (s.confidence < STANCE_CONFIDENCE_UNCLEAR) continue;
          if (s.confidence < 0.50) finalStance = "UNCLEAR";
          if (s.quoted_text && !seg.text_content.includes(s.quoted_text)) {
            finalStance = "UNCLEAR";
          }

          const prop = matches.find((p) => p.proposition_id === s.proposition_id);
          if (!prop) continue;

          await supabase.from("stance_extractions").upsert({
            segment_id: seg.id,
            proposition_id: s.proposition_id,
            stance: finalStance,
            confidence: s.confidence,
            quoted_text: s.quoted_text || null,
            model_id: config.model,
            model_version: String(config.version),
            scoring_version: IDEOLOGY_SCORING_VERSION,
          }, { onConflict: "segment_id,proposition_id,scoring_version" });

          totalStanceExtractions++;

          if (finalStance === "PRO" || finalStance === "ANTI") {
            allStanceVotes.push({
              proposition_id: s.proposition_id,
              stance: finalStance as "PRO" | "ANTI",
              confidence: s.confidence,
              liberal_is_pro: prop.liberal_is_pro,
              difficulty_b: prop.difficulty_b,
              domain: prop.domain,
            });
          }
        }
      } catch (e) {
        console.warn(`Stance error for segment ${seg.id}:`, e instanceof Error ? e.message : e);
      }
    }

    // 5a. Deterministic domain cap: no single domain contributes > 40% of stances
    // If exceeded, drop lowest-confidence stances from that domain
    const domainCounts: Record<string, number> = {};
    for (const v of allStanceVotes) {
      domainCounts[v.domain || "unknown"] = (domainCounts[v.domain || "unknown"] || 0) + 1;
    }
    const maxPerDomain = Math.max(1, Math.ceil(allStanceVotes.length * DOMAIN_CAP_FRACTION));
    for (const [domain, count] of Object.entries(domainCounts)) {
      if (count > maxPerDomain) {
        // Get indices of this domain's votes, sorted by confidence ascending (lowest first)
        const domainIndices = allStanceVotes
          .map((v, i) => ({ idx: i, conf: v.confidence, dom: v.domain || "unknown" }))
          .filter((v) => v.dom === domain)
          .sort((a, b) => a.conf - b.conf);
        // Remove lowest-confidence votes until at cap
        const toRemove = new Set(domainIndices.slice(0, count - maxPerDomain).map((v) => v.idx));
        // Filter in reverse index order to preserve indices
        for (let i = allStanceVotes.length - 1; i >= 0; i--) {
          if (toRemove.has(i)) allStanceVotes.splice(i, 1);
        }
      }
    }

    // 5b. Diversity guards: require ≥2 unique propositions and ≥2 domains
    const uniqueProps = new Set(allStanceVotes.map((v) => v.proposition_id));
    const uniqueDomains = new Set(allStanceVotes.map((v) => v.domain || "unknown"));

    let docResult;
    let docEconomic: number | null = null;
    let docSocial: number | null = null;

    if (uniqueProps.size < 2 || uniqueDomains.size < 2) {
      // Insufficient diversity → null score
      docResult = {
        score: null,
        theta_raw: null,
        se: null,
        n_propositions: uniqueProps.size,
        mean_confidence: allStanceVotes.length > 0
          ? allStanceVotes.reduce((s, v) => s + v.confidence, 0) / allStanceVotes.length
          : 0,
        iterations: 0,
        method: "map_irt" as const,
        reason: uniqueDomains.size < 2 ? "single_domain_coverage" : "insufficient_proposition_diversity",
      };
    } else {
      // Document-level aggregation via MAP IRT on all collected votes
      docResult = computeIdeologyMap(allStanceVotes);

      if (allStanceVotes.length >= IRT_MIN_STANCES) {
        // 2D: compute economic and social separately
        const econVotes = allStanceVotes.filter((v) =>
          ["economic"].includes(getDimensionForDomain(v.domain || ""))
        );
        const socialVotes = allStanceVotes.filter((v) =>
          ["social", "executive"].includes(getDimensionForDomain(v.domain || ""))
        );
        const econResult = computeIdeologyMap(econVotes.length >= 2 ? econVotes : []);
        const socialResult = computeIdeologyMap(socialVotes.length >= 2 ? socialVotes : []);
        docEconomic = econResult.score;
        docSocial = socialResult.score;
      }
    }

    // Write to documents.ideology_scores (legacy format)
    await writeDocIdeology(supabase, documentId, docResult.score, {
      theta_raw: docResult.theta_raw,
      se: docResult.se,
      theta_economic: docEconomic,
      theta_social: docSocial,
      n_stances: allStanceVotes.length,
      n_propositions: new Set(allStanceVotes.map((v) => v.proposition_id)).size,
      mean_confidence: docResult.mean_confidence,
      method: docResult.method,
    });

    // Write to ideology_scores table
    await supabase.from("ideology_scores").upsert({
      entity_type: "document",
      entity_id: documentId,
      theta_raw: docResult.theta_raw,
      theta_normalized: docResult.score,
      se: docResult.se,
      theta_economic: docEconomic,
      theta_social: docSocial,
      n_stances: allStanceVotes.length,
      n_propositions: new Set(allStanceVotes.map((v) => v.proposition_id)).size,
      mean_confidence: docResult.mean_confidence,
      method: docResult.method,
      scoring_version: IDEOLOGY_SCORING_VERSION,
      model_id: "system",
      metadata: {
        total_stance_extractions: totalStanceExtractions,
        segments_matched: segMatches.length,
        segments_processed: toProcess.length,
        segments_total: segments.length,
      },
    }, { onConflict: "entity_type,entity_id" }).select();

    console.log(`Ideology v2: doc=${documentId}, score=${docResult.score}, stances=${allStanceVotes.length}, matched=${segMatches.length}, processed=${toProcess.length}`);

    return respond({
      scored: true,
      document_id: documentId,
      score: docResult.score,
      theta_economic: docEconomic,
      theta_social: docSocial,
      total_stances: allStanceVotes.length,
      total_extractions: totalStanceExtractions,
      segments_matched: segMatches.length,
      segments_processed: toProcess.length,
    });
  } catch (e) {
    console.error("Oracle Ideology v2 fatal:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ---- Helpers ----

function respond(data: Record<string, unknown>) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function writeDocIdeology(
  supabase: any,
  docId: string,
  score: number | null,
  extra?: Record<string, unknown>
) {
  // IRT-conformant schema: no freeform reasoning field
  const legacyEconomic = extra?.theta_economic != null ? Math.round((extra.theta_economic as number) * 10 * 100) / 100 : null;
  const legacySocial = extra?.theta_social != null ? Math.round((extra.theta_social as number) * 10 * 100) / 100 : null;

  const ideologyScores = score !== null
    ? {
        economic: legacyEconomic ?? (score != null ? Math.round(score * 10 * 100) / 100 : 0),
        social: legacySocial ?? (score != null ? Math.round(score * 10 * 100) / 100 : 0),
        confidence: extra?.mean_confidence ?? null,
        method: extra?.method ?? "map_irt",
        theta_raw: extra?.theta_raw ?? null,
        se: extra?.se ?? null,
        n_stances: extra?.n_stances ?? 0,
        n_propositions: extra?.n_propositions ?? 0,
        scoring_version: IDEOLOGY_SCORING_VERSION,
      }
    : {
        economic: null,
        social: null,
        confidence: null,
        method: "map_irt",
        theta_raw: null,
        se: null,
        n_stances: 0,
        n_propositions: 0,
        scoring_version: IDEOLOGY_SCORING_VERSION,
        reason: "insufficient_ideological_signal",
      };

  await supabase
    .from("documents")
    .update({ ideology_scores: ideologyScores })
    .eq("id", docId);
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function classificationToDomain(classification: string | null): string | null {
  if (!classification) return null;
  const c = classification.toLowerCase();
  if (c.includes("immigration")) return "immigration";
  if (c.includes("fiscal") || c.includes("tax") || c.includes("budget")) return "fiscal_policy";
  if (c.includes("regulation") || c.includes("regulatory")) return "regulation";
  if (c.includes("social") || c.includes("abortion") || c.includes("lgbtq")) return "social_policy";
  if (c.includes("criminal") || c.includes("police") || c.includes("crime")) return "criminal_justice";
  if (c.includes("foreign") || c.includes("military") || c.includes("defense")) return "foreign_policy";
  if (c.includes("labor") || c.includes("worker") || c.includes("union")) return "labor";
  if (c.includes("environment") || c.includes("climate") || c.includes("energy")) return "environment";
  if (c.includes("executive") || c.includes("president")) return "executive_power";
  if (c.includes("corporate") || c.includes("antitrust")) return "corporate_governance";
  return null;
}

function getDimensionForDomain(domain: string): string {
  const map: Record<string, string> = {
    immigration: "social",
    fiscal_policy: "economic",
    regulation: "economic",
    social_policy: "social",
    criminal_justice: "social",
    foreign_policy: "foreign",
    labor: "economic",
    environment: "economic",
    executive_power: "executive",
    corporate_governance: "economic",
  };
  return map[domain] || "general";
}
