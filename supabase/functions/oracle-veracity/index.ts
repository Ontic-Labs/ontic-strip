import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  TIER_RANK,
  OFFICIAL_DOMAINS,
  WIRE_DOMAINS,
  REFERENCE_DOMAINS,
  SCOPE_JACCARD_MIN,
  SCOPE_EMBEDDING_SIM_MIN,
  SCOPE_LEGAL_JACCARD_MIN,
  SCOPE_GEOPOLITICAL_JACCARD_MIN,
  SCOPE_FAIL_CONFIDENCE_CAP,
  MIXED_MIN_STRENGTH,
  MIXED_MAX_DELTA,
  CONTRADICTION_MIN_CONF,
  SUPPORT_MIN_CONF,
  LOW_TIER_SUPPORT_CONFIDENCE_CAP,
  CRITICAL_MAX_TIER_RANK,
  HIGH_MAX_TIER_RANK,
  CRITICAL_GATED_CONFIDENCE,
  HIGH_GATED_CONFIDENCE,
  LOW_TIER_THRESHOLD,
  SEGMENT_WEIGHT_SUPPORTED,
  SEGMENT_WEIGHT_CONTRADICTED,
  SEGMENT_WEIGHT_MIXED,
  SEGMENT_MIXED_MASS_THRESHOLD,
  SEGMENT_SUPPORTED_THRESHOLD,
  SEGMENT_CONTRADICTED_THRESHOLD,
} from "../_shared/scoring-constants.ts";
import { compilePrompt } from "../_shared/prompt-builder.ts";
import { callLlm } from "../_shared/llm-client.ts";
import { veracityNliTemplate, buildNliUserPrompt } from "../_shared/prompts/veracity-nli.ts";
import { veracityWebTemplate, buildWebVerifyUserPrompt } from "../_shared/prompts/veracity-web.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LLM_TIMEOUT_MS = 60_000;

// --------------- Risk-based tier requirements ---------------

function highestTier(tiers: string[]): number {
  let best = 99;
  for (const t of tiers) {
    const rank = TIER_RANK[t] || 99;
    if (rank < best) best = rank;
  }
  return best;
}

// --------------- Web evidence tier promotion ---------------

function getUrlDomain(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return null; }
}

function assignWebTier(url: string): string {
  const domain = getUrlDomain(url);
  if (!domain) return "T4";
  for (const d of OFFICIAL_DOMAINS) {
    if (domain === d || domain.endsWith(`.${d}`)) return "T1";
  }
  for (const d of WIRE_DOMAINS) {
    if (domain === d || domain.endsWith(`.${d}`)) return "T2";
  }
  for (const d of REFERENCE_DOMAINS) {
    if (domain === d || domain.endsWith(`.${d}`)) return "T3";
  }
  return "T4";
}

// --------------- Weighted segment label resolution ---------------

function resolveSegmentLabel(
  claimVerdicts: { label: string; confidence: number }[]
): string {
  if (claimVerdicts.length === 0) return "NOT_CHECKABLE";

  let pos = 0, neg = 0;

  for (const c of claimVerdicts) {
    const w = Math.max(0, Math.min(1, c.confidence));
    if (c.label === "SUPPORTED") pos += SEGMENT_WEIGHT_SUPPORTED * w;
    else if (c.label === "CONTRADICTED") neg += SEGMENT_WEIGHT_CONTRADICTED * w;
    else if (c.label === "MIXED") { pos += SEGMENT_WEIGHT_MIXED * w; neg += SEGMENT_WEIGHT_MIXED * w; }
  }

  if (pos >= SEGMENT_MIXED_MASS_THRESHOLD && neg >= SEGMENT_MIXED_MASS_THRESHOLD) return "MIXED";
  const score = pos - neg;
  if (score >= SEGMENT_SUPPORTED_THRESHOLD) return "SUPPORTED";
  if (score <= SEGMENT_CONTRADICTED_THRESHOLD) return "CONTRADICTED";

  const hasVerifiable = claimVerdicts.some(c =>
    ["SUPPORTED", "CONTRADICTED", "MIXED"].includes(c.label)
  );
  if (!hasVerifiable) return "NOT_CHECKABLE";
  return "UNKNOWN";
}

// ---------- Prompts loaded from CFPO templates ----------

// ---------- Types ----------

interface NLIResult {
  nli_label: string;
  nli_confidence: number;
  reasoning: string;
}

interface WebSource {
  url: string;
  publisher: string;
  snippet: string;
  stance: string;
}

interface WebNLIResult extends NLIResult {
  sources: WebSource[];
}

// ---------- Corpus NLI scoring ----------

async function scoreCorpusNLI(
  pairs: { claim_text: string; evidence_text: string; pair_index: number }[],
  apiKey: string
): Promise<NLIResult[]> {
  const userPrompt = buildNliUserPrompt(
    pairs.map((p) => ({ claimText: p.claim_text, evidenceText: p.evidence_text, pairIndex: p.pair_index }))
  );

  const { systemPrompt, config } = compilePrompt("veracity-nli", veracityNliTemplate);

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
      throw new Error(`Corpus NLI scoring timed out after ${LLM_TIMEOUT_MS}ms`);
    }
    throw e;
  }

  const parsed: NLIResult[] = JSON.parse(content);

  if (!Array.isArray(parsed) || parsed.length !== pairs.length) {
    throw new Error(`Expected ${pairs.length} corpus NLI results, got ${Array.isArray(parsed) ? parsed.length : "non-array"}`);
  }

  return parsed.map((r) => ({
    nli_label: ["ENTAILMENT", "CONTRADICTION", "NEUTRAL"].includes(r.nli_label)
      ? r.nli_label
      : "NEUTRAL",
    nli_confidence: Math.max(0, Math.min(1, r.nli_confidence || 0.5)),
    reasoning: r.reasoning || "",
  }));
}

// ---------- Web verification ----------

async function verifyClaimsViaWeb(
  claims: { claim_text: string; claim_index: number }[],
  apiKey: string
): Promise<WebNLIResult[]> {
  const userPrompt = buildWebVerifyUserPrompt(
    claims.map((c) => ({ claimText: c.claim_text, claimIndex: c.claim_index }))
  );

  const { systemPrompt, config } = compilePrompt("veracity-web", veracityWebTemplate);

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
      throw new Error(`Web verification timed out after ${LLM_TIMEOUT_MS}ms`);
    }
    throw e;
  }

  const parsed: WebNLIResult[] = JSON.parse(content);

  if (!Array.isArray(parsed) || parsed.length !== claims.length) {
    throw new Error(`Expected ${claims.length} web verify results, got ${Array.isArray(parsed) ? parsed.length : "non-array"}`);
  }

  return parsed.map((r) => ({
    nli_label: ["ENTAILMENT", "CONTRADICTION", "NEUTRAL"].includes(r.nli_label)
      ? r.nli_label
      : "NEUTRAL",
    nli_confidence: Math.max(0, Math.min(1, r.nli_confidence || 0.5)),
    reasoning: r.reasoning || "",
    sources: Array.isArray(r.sources)
      ? r.sources.filter((s: any) => s && typeof s === "object" && s.url).map((s: any) => ({
          url: String(s.url || ""),
          publisher: String(s.publisher || ""),
          snippet: String(s.snippet || ""),
          stance: ["SUPPORTS", "CONTRADICTS", "NEUTRAL"].includes(s.stance) ? s.stance : "NEUTRAL",
        }))
      : [],
  }));
}

// --------------- Scope-match gate for contradictions ---------------

const STOP_WORDS = new Set([
  "the","a","an","and","or","to","of","in","on","for","with","by","as","at","from",
  "is","are","was","were","be","been","being","it","that","this","these","those",
  "they","he","she","we","you","i","their","his","her","has","have","had","not",
]);

function tokenizeForScope(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) { if (b.has(w)) inter++; }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? inter / union : 0;
}

function isLegalClaim(text: string): boolean {
  return /\billegal\b|\blaw\b|\bprohibit(ed|s)?\b|\bban(ned|s)?\b|\bpermitted\b|\ballowed\b|\bregulated\b/i.test(text);
}

function isGeopoliticalEventClaim(text: string): boolean {
  return /\b(bomb(ed|ing|s)?|strike[sd]?|airstrike[sd]?|attack(ed|s)?|shelling|missile[sd]?|invasion|offensive|raid(ed|s)?|shell(ed|ing)?)\b/i.test(text)
    && /\b[A-Z][a-z]+\b/.test(text); // Has a proper noun (location/entity)
}

function scopeMatch(
  claimText: string,
  evidenceText: string,
  embeddingSim?: number
): { ok: boolean; reason?: string } {
  const claimTokens = new Set(tokenizeForScope(claimText));
  const evTokens = new Set(tokenizeForScope(evidenceText));
  const jac = jaccardOverlap(claimTokens, evTokens);

  const simOk = (embeddingSim ?? 0) >= SCOPE_EMBEDDING_SIM_MIN;
  const overlapOk = jac >= SCOPE_JACCARD_MIN;

  if (!(simOk || overlapOk)) {
    return { ok: false, reason: "LOW_PROPOSITION_OVERLAP" };
  }

  if (isLegalClaim(claimText) && jac < SCOPE_LEGAL_JACCARD_MIN && !simOk) {
    return { ok: false, reason: "LEGAL_CLAIM_SCOPE_MISMATCH" };
  }

  // Geopolitical event claims: require higher lexical overlap to prevent false contradictions
  // when evidence covers same region but different specific events
  if (isGeopoliticalEventClaim(claimText) && jac < SCOPE_GEOPOLITICAL_JACCARD_MIN && !simOk) {
    return { ok: false, reason: "GEOPOLITICAL_EVENT_SCOPE_MISMATCH" };
  }

  return { ok: true };
}

// --------------- Veracity computation ---------------

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function computeVeracity(
  nliLabels: { label: string; confidence: number; isIndependent: boolean; claimText?: string; evidenceText?: string; embeddingSim?: number }[]
): { veracity: string; confidence: number; gapReason: string | null; conflictBasis: string | null; scopeDowngraded: number; scopeDowngradedSupport: number } {
  if (nliLabels.length === 0) {
    return { veracity: "UNKNOWN", confidence: 0.5, gapReason: "NO_RELEVANT_EVIDENCE", conflictBasis: null, scopeDowngraded: 0, scopeDowngradedSupport: 0 };
  }

  const independentLabels = nliLabels.filter((l) => l.isIndependent);
  if (independentLabels.length === 0) {
    return { veracity: "UNKNOWN", confidence: 0.3, gapReason: "CIRCULAR_ONLY", conflictBasis: null, scopeDowngraded: 0, scopeDowngradedSupport: 0 };
  }

  // Apply scope-match gate: downgrade contradictions AND entailments that fail scope check
  let scopeDowngraded = 0;
  let scopeDowngradedSupport = 0;
  const originalContradictions = independentLabels.filter(l => l.label === "CONTRADICTION").length;
  const originalEntailments = independentLabels.filter(l => l.label === "ENTAILMENT").length;
  const labels = independentLabels.map((l) => {
    if (l.label !== "CONTRADICTION" && l.label !== "ENTAILMENT") return l;
    if (l.claimText && l.evidenceText) {
      const sm = scopeMatch(l.claimText, l.evidenceText, l.embeddingSim);
      if (!sm.ok) {
        if (l.label === "CONTRADICTION") {
          scopeDowngraded++;
          console.log(`Scope-gate downgrade (contradict): "${l.claimText?.slice(0, 80)}..." — reason: ${sm.reason}`);
        } else {
          scopeDowngradedSupport++;
          console.log(`Scope-gate downgrade (support): "${l.claimText?.slice(0, 80)}..." — reason: ${sm.reason}`);
        }
        return { ...l, label: "NEUTRAL", confidence: Math.min(l.confidence, SCOPE_FAIL_CONFIDENCE_CAP) };
      }
    }
    return l;
  });
  if (scopeDowngraded > 0) {
    console.log(`Scope-match gate: ${scopeDowngraded}/${originalContradictions} contradictions downgraded to NEUTRAL`);
  }
  if (scopeDowngradedSupport > 0) {
    console.log(`Scope-match gate: ${scopeDowngradedSupport}/${originalEntailments} entailments downgraded to NEUTRAL`);
  }

  const entailments = labels.filter((l) => l.label === "ENTAILMENT");
  const contradictions = labels.filter((l) => l.label === "CONTRADICTION");
  const neutrals = labels.filter((l) => l.label === "NEUTRAL");

  const supportStrength = avg(entailments.map(e => e.confidence));
  const contradictStrength = avg(contradictions.map(c => c.confidence));

  // Both sides exist: apply confidence-delta threshold for MIXED
  if (entailments.length > 0 && contradictions.length > 0) {
    const delta = Math.abs(supportStrength - contradictStrength);

    if (Math.min(supportStrength, contradictStrength) >= MIXED_MIN_STRENGTH && delta <= MIXED_MAX_DELTA) {
      const conflictBasis = `${entailments.length} source(s) support (avg ${(supportStrength * 100).toFixed(0)}%) vs ${contradictions.length} source(s) contradict (avg ${(contradictStrength * 100).toFixed(0)}%)`;
      return {
        veracity: "MIXED",
        confidence: Math.max(supportStrength, contradictStrength),
        gapReason: "EVIDENCE_CONFLICT",
        conflictBasis,
        scopeDowngraded,
        scopeDowngradedSupport,
      };
    }

    if (supportStrength >= contradictStrength && supportStrength >= SUPPORT_MIN_CONF) {
      return { veracity: "SUPPORTED", confidence: supportStrength, gapReason: null, conflictBasis: null, scopeDowngraded, scopeDowngradedSupport };
    }
    if (contradictStrength > supportStrength && contradictStrength >= CONTRADICTION_MIN_CONF) {
      return { veracity: "CONTRADICTED", confidence: contradictStrength, gapReason: null, conflictBasis: null, scopeDowngraded, scopeDowngradedSupport };
    }
    return {
      veracity: "UNKNOWN",
      confidence: Math.max(supportStrength, contradictStrength, avg(neutrals.map(n => n.confidence))),
      gapReason: "WEAK_CONFLICT",
      conflictBasis: `${entailments.length} support (avg ${(supportStrength * 100).toFixed(0)}%) vs ${contradictions.length} contradict (avg ${(contradictStrength * 100).toFixed(0)}%) — neither strong enough`,
      scopeDowngraded,
      scopeDowngradedSupport,
    };
  }

  if (contradictions.length > 0) {
    if (contradictStrength < CONTRADICTION_MIN_CONF) {
      return { veracity: "UNKNOWN", confidence: contradictStrength, gapReason: "WEAK_CONTRADICTION", conflictBasis: null, scopeDowngraded, scopeDowngradedSupport };
    }
    return { veracity: "CONTRADICTED", confidence: contradictStrength, gapReason: null, conflictBasis: null, scopeDowngraded, scopeDowngradedSupport };
  }

  if (entailments.length > 0) {
    if (supportStrength < SUPPORT_MIN_CONF) {
      return { veracity: "UNKNOWN", confidence: supportStrength, gapReason: "WEAK_SUPPORT", conflictBasis: null, scopeDowngraded, scopeDowngradedSupport };
    }
    return { veracity: "SUPPORTED", confidence: supportStrength, gapReason: null, conflictBasis: null, scopeDowngraded, scopeDowngradedSupport };
  }

  const avgConf = avg(neutrals.map(n => n.confidence)) || 0.5;
  return { veracity: "UNKNOWN", confidence: avgConf, gapReason: "NEUTRAL_ONLY", conflictBasis: null, scopeDowngraded, scopeDowngradedSupport };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const obj = e as Record<string, unknown>;
    return obj.message ? String(obj.message) : JSON.stringify(e);
  }
  return String(e);
}

// ---------- Main Handler ----------

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
    let claimLimit = 10;
    let pairBatchSize = 8;
    let webBatchSize = 5;
    try {
      const body = await req.json();
      documentId = body.document_id || null;
      claimLimit = body.claim_limit || 10;
      pairBatchSize = body.pair_batch_size || 8;
      webBatchSize = body.web_batch_size || 5;
    } catch {
      // No body
    }

    if (!documentId) {
      return json({ error: "document_id is required" }, 400);
    }

    // Idempotency: only process if still in verifying state
    const { data: doc, error: fetchErr } = await supabase
      .from("documents")
      .select("id")
      .eq("id", documentId)
      .eq("pipeline_status", "verifying")
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!doc) {
      return json({ skipped: true, message: "Document not in verifying state (already processed or missing)" });
    }

    let totalScored = 0;
    let totalSupported = 0;
    let totalContradicted = 0;
    let totalMixed = 0;
    let totalUnknown = 0;
    let totalWebVerified = 0;
    let totalRiskGated = 0;
    let totalScopeDowngraded = 0;
    let totalScopeDowngradedSupport = 0;

    console.log(`Processing doc ${doc.id}`);

    const { data: claimBatch, error: clErr } = await supabase
      .from("claims")
      .select("id, claim_text, risk_level, sire_retrieval")
      .eq("document_id", doc.id)
      .is("veracity_label", null)
      .limit(claimLimit);

    if (clErr) throw clErr;

    if (!claimBatch || claimBatch.length === 0) {
      const { data: updated } = await supabase
        .from("documents")
        .update({ pipeline_status: "aggregated" })
        .eq("id", doc.id)
        .eq("pipeline_status", "verifying")
        .select("id")
        .maybeSingle();
      return json({ scored: 0, advanced: !!updated, message: "No unscored claims" });
    }

    const claimIds = claimBatch.map((c) => c.id);

    const { data: evidenceRows, error: evErr } = await supabase
      .from("evidence")
      .select("id, claim_id, evidence_text, nli_label, source_tier, is_independent, similarity_score")
      .in("claim_id", claimIds)
      .is("nli_label", null);

    if (evErr) throw evErr;

    const claimEvidenceMap = new Map<string, { evidence_id: string; evidence_text: string; source_tier: string; is_independent: boolean; similarity_score: number | null }[]>();
    for (const ev of evidenceRows || []) {
      const list = claimEvidenceMap.get(ev.claim_id) || [];
      list.push({
        evidence_id: ev.id,
        evidence_text: ev.evidence_text,
        source_tier: ev.source_tier,
        is_independent: ev.is_independent !== false,
        similarity_score: ev.similarity_score,
      });
      claimEvidenceMap.set(ev.claim_id, list);
    }

    const corpusPairs: {
      claim_id: string;
      claim_text: string;
      evidence_id: string;
      evidence_text: string;
      source_tier: string;
      is_independent: boolean;
      pair_index: number;
    }[] = [];
    const webClaims: { claim_id: string; claim_text: string; risk_level: string; is_attribution: boolean; claim_type: string }[] = [];

    for (const claim of claimBatch) {
      const sireRetrieval = (claim.sire_retrieval as Record<string, unknown>) || {};
      const isAttribution = sireRetrieval.is_attribution === true || sireRetrieval.claim_type === "ATTRIBUTION";
      const claimType = (sireRetrieval.claim_type as string) || "DIRECT";
      const evidence = claimEvidenceMap.get(claim.id);
      if (!evidence || evidence.length === 0) {
        webClaims.push({ claim_id: claim.id, claim_text: claim.claim_text, risk_level: claim.risk_level || "LOW", is_attribution: isAttribution, claim_type: claimType });
      } else {
        for (const ev of evidence) {
          corpusPairs.push({
            claim_id: claim.id,
            claim_text: claim.claim_text,
            evidence_id: ev.evidence_id,
            evidence_text: ev.evidence_text,
            source_tier: ev.source_tier,
            is_independent: ev.is_independent,
            pair_index: corpusPairs.length,
          });
        }
      }
    }

    console.log(`Doc ${doc.id}: ${corpusPairs.length} corpus NLI pairs, ${webClaims.length} claims for web verification`);

    // ---- Process corpus NLI pairs ----
    for (let i = 0; i < corpusPairs.length; i += pairBatchSize) {
      const batch = corpusPairs.slice(i, i + pairBatchSize);
      const nliInput = batch.map((p, idx) => ({
        claim_text: p.claim_text,
        evidence_text: p.evidence_text,
        pair_index: idx,
      }));

      const nliResults = await scoreCorpusNLI(nliInput, openrouterKey);

      // Update evidence NLI labels
      for (let j = 0; j < batch.length; j++) {
        const pair = batch[j];
        const result = nliResults[j];
        const { error: updErr } = await supabase
          .from("evidence")
          .update({
            nli_label: result.nli_label,
            nli_confidence: result.nli_confidence,
          })
          .eq("id", pair.evidence_id);
        if (updErr) throw updErr;
      }
    }

    // ---- Web verification for claims without corpus evidence ----
    const attributionWebClaims = webClaims.filter(c => c.claim_type === "ATTRIBUTION");
    const regularWebClaims = webClaims.filter(c => c.claim_type !== "ATTRIBUTION");

    // Process regular web claims
    for (let i = 0; i < regularWebClaims.length; i += webBatchSize) {
      const batch = regularWebClaims.slice(i, i + webBatchSize);
      const webInput = batch.map((c, idx) => ({
        claim_text: c.claim_text,
        claim_index: idx,
      }));

      const webResults = await verifyClaimsViaWeb(webInput, openrouterKey);

      for (let j = 0; j < batch.length; j++) {
        const claim = batch[j];
        const result = webResults[j];

        const stanceToNli: Record<string, string> = {
          SUPPORTS: "ENTAILMENT",
          CONTRADICTS: "CONTRADICTION",
          NEUTRAL: "NEUTRAL",
        };

        const seenUrls = new Set<string>();
        for (const src of result.sources.slice(0, 5)) {
          if (seenUrls.has(src.url)) continue;
          seenUrls.add(src.url);
          const webTier = assignWebTier(src.url);
          const { error: insertErr } = await supabase.from("evidence").insert({
            claim_id: claim.claim_id,
            evidence_text: src.snippet || result.reasoning,
            source_tier: webTier,
            source_url: src.url,
            source_publisher: src.publisher || getUrlDomain(src.url) || "unknown",
            nli_label: stanceToNli[src.stance] || result.nli_label,
            nli_confidence: result.nli_confidence,
            is_independent: true,
          });
          if (insertErr) throw insertErr;
        }

        if (result.sources.length === 0) {
          const { error: insertErr } = await supabase.from("evidence").insert({
            claim_id: claim.claim_id,
            evidence_text: result.reasoning,
            source_tier: "T4",
            nli_label: result.nli_label,
            nli_confidence: result.nli_confidence,
            is_independent: true,
          });
          if (insertErr) throw insertErr;
        }

        totalWebVerified++;
      }
    }

    // ---- Attribution web verification ----
    for (let i = 0; i < attributionWebClaims.length; i += webBatchSize) {
      const batch = attributionWebClaims.slice(i, i + webBatchSize);
      const webInput = batch.map((c, idx) => ({
        claim_text: `Verify that this statement was actually made: ${c.claim_text}. Search for the primary source (official transcript, social media post, press conference, or direct recording). Only confirm if you find the original statement or a credible report of it.`,
        claim_index: idx,
      }));

      const webResults = await verifyClaimsViaWeb(webInput, openrouterKey);

      for (let j = 0; j < batch.length; j++) {
        const claim = batch[j];
        const result = webResults[j];

        const stanceToNli: Record<string, string> = {
          SUPPORTS: "ENTAILMENT",
          CONTRADICTS: "CONTRADICTION",
          NEUTRAL: "NEUTRAL",
        };

        const seenUrls = new Set<string>();
        for (const src of result.sources.slice(0, 5)) {
          if (seenUrls.has(src.url)) continue;
          seenUrls.add(src.url);
          const webTier = assignWebTier(src.url);
          const { error: insertErr } = await supabase.from("evidence").insert({
            claim_id: claim.claim_id,
            evidence_text: src.snippet || result.reasoning,
            source_tier: webTier,
            source_url: src.url,
            source_publisher: src.publisher || getUrlDomain(src.url) || "unknown",
            nli_label: stanceToNli[src.stance] || result.nli_label,
            nli_confidence: result.nli_confidence,
            is_independent: true,
          });
          if (insertErr) throw insertErr;
        }

        if (result.sources.length === 0) {
          const { error: insertErr } = await supabase.from("evidence").insert({
            claim_id: claim.claim_id,
            evidence_text: result.reasoning,
            source_tier: "T4",
            nli_label: "NEUTRAL",
            nli_confidence: 0.5,
            is_independent: true,
          });
          if (insertErr) throw insertErr;
        }

        totalWebVerified++;
      }
    }

    // ---- Compute veracity per claim (with risk gating) ----
    for (const claim of claimBatch) {
      const riskLevel = (claim.risk_level || "LOW") as string;
      const sireRetrieval = (claim.sire_retrieval as Record<string, unknown>) || {};
      const isAttribution = sireRetrieval.is_attribution === true || sireRetrieval.claim_type === "ATTRIBUTION";

      const { data: claimEvidence } = await supabase
        .from("evidence")
        .select("nli_label, nli_confidence, source_tier, is_independent, evidence_text, similarity_score")
        .eq("claim_id", claim.id)
        .not("nli_label", "is", null);

      if (!claimEvidence || claimEvidence.length === 0) {
        const gapReason = isAttribution ? "PRIMARY_SOURCE_NOT_RETRIEVED" : "NO_RELEVANT_EVIDENCE";
        await supabase
          .from("claims")
          .update({
            veracity_label: "UNKNOWN",
            confidence_score: 0.5,
            gap_reason: gapReason,
          })
          .eq("id", claim.id);
        totalScored++;
        totalUnknown++;
        continue;
      }

      // Risk-based tier gating
      const evidenceTiers = claimEvidence.map((e) => e.source_tier);
      const bestTier = highestTier(evidenceTiers);

      if (riskLevel === "CRITICAL" && bestTier > CRITICAL_MAX_TIER_RANK) {
        await supabase
          .from("claims")
          .update({
            veracity_label: "UNKNOWN",
            confidence_score: CRITICAL_GATED_CONFIDENCE,
            gap_reason: "INSUFFICIENT_TIER_FOR_RISK",
          })
          .eq("id", claim.id);
        totalScored++;
        totalUnknown++;
        totalRiskGated++;
        console.log(`Claim ${claim.id}: CRITICAL risk gated (best tier: T${bestTier})`);
        continue;
      }

      if (riskLevel === "HIGH" && bestTier > HIGH_MAX_TIER_RANK) {
        await supabase
          .from("claims")
          .update({
            veracity_label: "UNKNOWN",
            confidence_score: HIGH_GATED_CONFIDENCE,
            gap_reason: "INSUFFICIENT_TIER_FOR_RISK",
          })
          .eq("id", claim.id);
        totalScored++;
        totalUnknown++;
        totalRiskGated++;
        console.log(`Claim ${claim.id}: HIGH risk gated (best tier: T${bestTier})`);
        continue;
      }

      const nliLabels = claimEvidence.map((e) => ({
        label: e.nli_label!,
        confidence: e.nli_confidence || 0.5,
        isIndependent: e.is_independent !== false,
        claimText: claim.claim_text,
        evidenceText: e.evidence_text,
        embeddingSim: e.similarity_score ?? undefined,
      }));

      const { veracity, confidence, gapReason, conflictBasis, scopeDowngraded: sd, scopeDowngradedSupport: sdS } = computeVeracity(nliLabels);
      totalScopeDowngraded += sd;
      totalScopeDowngradedSupport += sdS;

      // Attribution claim protection: never label CONTRADICTED
      let finalVeracity = veracity;
      let finalGapReason = gapReason;
      if (isAttribution && veracity === "CONTRADICTED") {
        finalVeracity = "UNKNOWN";
        finalGapReason = "PRIMARY_SOURCE_NOT_RETRIEVED";
        console.log(`Claim ${claim.id}: Attribution claim downgraded from CONTRADICTED to UNKNOWN`);
      }

      // Confidence cap for low-tier-only evidence
      let finalConfidence = confidence;
      if (bestTier >= LOW_TIER_THRESHOLD && finalVeracity === "SUPPORTED") {
        finalConfidence = Math.min(confidence, LOW_TIER_SUPPORT_CONFIDENCE_CAP);
      }

      await supabase
        .from("claims")
        .update({
          veracity_label: finalVeracity,
          confidence_score: finalConfidence,
          gap_reason: finalGapReason,
          conflict_basis: conflictBasis,
        })
        .eq("id", claim.id);

      totalScored++;
      switch (finalVeracity) {
        case "SUPPORTED": totalSupported++; break;
        case "CONTRADICTED": totalContradicted++; break;
        case "MIXED": totalMixed++; break;
        case "UNKNOWN": totalUnknown++; break;
      }
    }

    // ---- Update segment labels (weighted voting) ----
    const { data: factualSegments } = await supabase
      .from("segments")
      .select("id")
      .eq("document_id", doc.id)
      .eq("classification", "FACTUAL_CLAIM");

    for (const seg of factualSegments || []) {
      const { data: segClaims } = await supabase
        .from("claims")
        .select("veracity_label, confidence_score")
        .eq("segment_id", seg.id)
        .not("veracity_label", "is", null);

      if (!segClaims || segClaims.length === 0) continue;

      const segLabel = resolveSegmentLabel(segClaims.map(c => ({
        label: c.veracity_label as string,
        confidence: c.confidence_score ?? 0.5,
      })));

      await supabase.from("segments").update({ label: segLabel }).eq("id", seg.id);
    }

    // Check if all claims scored — advance if so
    const { data: remaining } = await supabase
      .from("claims")
      .select("id")
      .eq("document_id", doc.id)
      .is("veracity_label", null)
      .limit(1);

    if (!remaining || remaining.length === 0) {
      const { data: updated } = await supabase
        .from("documents")
        .update({ pipeline_status: "aggregated" })
        .eq("id", doc.id)
        .eq("pipeline_status", "verifying")
        .select("id")
        .maybeSingle();
      if (updated) console.log(`Doc ${doc.id}: all claims scored, moved to aggregated`);
    } else {
      console.log(`Doc ${doc.id}: ${remaining.length}+ claims still unscored`);
    }

    console.log(
      `Veracity done: ${doc.id} — ${totalScored} claims (${totalSupported} sup, ${totalContradicted} con, ${totalMixed} mix, ${totalUnknown} unk, ${totalWebVerified} web, ${totalRiskGated} risk-gated, ${totalScopeDowngraded} scope-down-contra, ${totalScopeDowngradedSupport} scope-down-support)`
    );
    return json({
      scored: totalScored,
      id: doc.id,
      web_verified: totalWebVerified,
      risk_gated: totalRiskGated,
      breakdown: { supported: totalSupported, contradicted: totalContradicted, mixed: totalMixed, unknown: totalUnknown },
      scope_downgraded: totalScopeDowngraded,
      scope_downgraded_support: totalScopeDowngradedSupport,
    });
  } catch (e) {
    const msg = errMsg(e);
    console.error("Veracity error:", msg);
    return json({ error: msg }, 500);
  }
});
