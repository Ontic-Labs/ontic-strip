import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  EMBEDDING_MODEL,
  SIMILARITY_THRESHOLD,
  MAX_EVIDENCE_PER_CLAIM,
  EVIDENCE_FETCH_HEADROOM,
  NEAR_DUPLICATE_THRESHOLD,
  OFFICIAL_DOMAINS,
  WIRE_DOMAINS,
  REFERENCE_DOMAINS,
} from "../_shared/scoring-constants.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

// --------------- Embed claim text ---------------

async function embedTexts(
  texts: string[],
  apiKey: string
): Promise<number[][] | null> {
  try {
    const resp = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`Embedding error: ${resp.status} ${err}`);
      return null;
    }

    const data = await resp.json();
    return data.data?.map((d: { embedding: number[] }) => d.embedding) || null;
  } catch (e) {
    console.error("Embedding failed:", e);
    return null;
  }
}

// --------------- Tier promotion by domain ---------------

function getDomain(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Mainstream news publishers whose corpus evidence should be T4, not T5 */
const MAINSTREAM_DOMAINS = new Set([
  "bbc.com", "bbc.co.uk", "npr.org", "cnn.com", "nytimes.com",
  "washingtonpost.com", "theguardian.com", "wsj.com", "ft.com",
  "thehill.com", "politico.com", "aljazeera.com", "foxnews.com",
  "nbcnews.com", "cbsnews.com", "abcnews.go.com", "usatoday.com",
  "latimes.com", "bloomberg.com", "economist.com", "time.com",
  "theatlantic.com", "jacobin.com", "thenation.com", "nationalreview.com",
  "reason.com", "motherjones.com", "dailywire.com", "breitbart.com",
]);

function getEvidenceTier(_publisherName: string | null, sourceCategory: string | null, sourceUrl: string | null): string {
  if (sourceUrl) {
    const domain = getDomain(sourceUrl);
    if (domain) {
      for (const official of OFFICIAL_DOMAINS) {
        if (domain === official || domain.endsWith(`.${official}`)) return "T1";
      }
      for (const wire of WIRE_DOMAINS) {
        if (domain === wire || domain.endsWith(`.${wire}`)) return "T2";
      }
      for (const ref of REFERENCE_DOMAINS) {
        if (domain === ref || domain.endsWith(`.${ref}`)) return "T3";
      }
      // Corpus evidence from mainstream publishers → T4, not T5
      for (const ms of MAINSTREAM_DOMAINS) {
        if (domain === ms || domain.endsWith(`.${ms}`)) return "T4";
      }
    }
  }

  if (sourceCategory === "reference") return "T3";
  if (sourceCategory === "mainstream") return "T4";
  return "T5";
}

// --------------- Near-duplicate detection ---------------

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function computeTextOverlap(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;

  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

// --------------- Evidence deduplication ---------------

function canonicalizeEvidence(text: string, url: string | null): string {
  const snippet = normalizeText(text).slice(0, 200);
  return `${url || "no-url"}::${snippet}`;
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
    let batchSize = 5;
    let claimBatchSize = 10;
    try {
      const body = await req.json();
      documentId = body.document_id || null;
      batchSize = body.batch_size || 5;
      claimBatchSize = body.claim_batch_size || 10;
    } catch {
      // No body
    }

    // Find documents in verifying stage
    let query = supabase
      .from("documents")
      .select("id, feed_id")
      .eq("pipeline_status", "verifying")
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (documentId) {
      query = supabase
        .from("documents")
        .select("id, feed_id")
        .eq("id", documentId)
        .limit(1);
    }

    const { data: docs, error: docsErr } = await query;
    if (docsErr) throw docsErr;
    if (!docs || docs.length === 0) {
      return new Response(
        JSON.stringify({ evidence_found: 0, message: "No documents to process" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const feedIds = [...new Set(docs.map((d) => d.feed_id))];
    const { data: feeds } = await supabase
      .from("feeds")
      .select("id, publisher_name, source_category")
      .in("id", feedIds);

    const feedMap = new Map(
      (feeds || []).map((f) => [f.id, { publisher: f.publisher_name, category: f.source_category }])
    );

    let totalEvidence = 0;
    let totalClaims = 0;
    let totalNonIndependent = 0;
    let totalDeduped = 0;
    const errors: string[] = [];

    for (const doc of docs) {
      try {
        const docPublisher = feedMap.get(doc.feed_id)?.publisher || null;

        const { data: claims, error: claimsErr } = await supabase
          .from("claims")
          .select("id, claim_text, sire_retrieval, segment_id")
          .eq("document_id", doc.id)
          .is("veracity_label", null)
          .order("created_at", { ascending: true });

        if (claimsErr) throw claimsErr;
        if (!claims || claims.length === 0) continue;

        const claimIds = claims.map((c) => c.id);
        const { data: existingEvidence } = await supabase
          .from("evidence")
          .select("claim_id")
          .in("claim_id", claimIds);

        const alreadyProcessed = new Set(
          (existingEvidence || []).map((e) => e.claim_id)
        );
        const toProcess = claims.filter((c) => !alreadyProcessed.has(c.id));

        if (toProcess.length === 0) continue;

        for (let i = 0; i < toProcess.length; i += claimBatchSize) {
          const batch = toProcess.slice(i, i + claimBatchSize);

          const claimTexts = batch.map((c) => c.claim_text);
          const embeddings = await embedTexts(claimTexts, openrouterKey);

          if (!embeddings || embeddings.length !== batch.length) {
            errors.push(`Doc ${doc.id}: embedding batch failed at offset ${i}`);
            continue;
          }

          for (let j = 0; j < batch.length; j++) {
            const claim = batch[j];
            const embedding = embeddings[j];
            totalClaims++;

            try {
              const embeddingStr = `[${embedding.join(",")}]`;

              const { data: matches, error: matchErr } = await supabase.rpc(
                "match_segments",
                {
                  query_embedding: embeddingStr,
                  match_threshold: SIMILARITY_THRESHOLD,
                  match_count: MAX_EVIDENCE_PER_CLAIM + EVIDENCE_FETCH_HEADROOM,
                  exclude_document_id: doc.id,
                }
              );

              if (matchErr) {
                errors.push(`Claim ${claim.id}: match error: ${matchErr.message}`);
                continue;
              }

              if (!matches || matches.length === 0) continue;

              const evidenceDocIds = [...new Set(matches.map((m: { document_id: string }) => m.document_id))];
              const { data: evidenceDocs } = await supabase
                .from("documents")
                .select("id, feed_id, url")
                .in("id", evidenceDocIds);

              const evidenceDocMap = new Map(
                (evidenceDocs || []).map((d) => [d.id, d])
              );

              const seenCanonical = new Set<string>();
              let insertedForClaim = 0;

              for (const match of matches) {
                if (insertedForClaim >= MAX_EVIDENCE_PER_CLAIM) break;

                const evidenceDoc = evidenceDocMap.get(match.document_id);
                const evidenceFeed = evidenceDoc ? feedMap.get(evidenceDoc.feed_id) : null;

                if (evidenceFeed?.publisher === docPublisher && docPublisher) {
                  continue;
                }

                const canonKey = canonicalizeEvidence(match.text_content, evidenceDoc?.url || null);
                if (seenCanonical.has(canonKey)) {
                  totalDeduped++;
                  continue;
                }
                seenCanonical.add(canonKey);

                const textOverlap = computeTextOverlap(claim.claim_text, match.text_content);
                const isIndependent = textOverlap < NEAR_DUPLICATE_THRESHOLD &&
                  match.similarity < NEAR_DUPLICATE_THRESHOLD;

                if (!isIndependent) {
                  totalNonIndependent++;
                }

                const tier = getEvidenceTier(
                  evidenceFeed?.publisher || null,
                  evidenceFeed?.category || null,
                  evidenceDoc?.url || null
                );

                const { error: insertErr } = await supabase.from("evidence").insert({
                  claim_id: claim.id,
                  source_segment_id: match.id,
                  evidence_text: match.text_content,
                  source_tier: tier,
                  source_url: evidenceDoc?.url || null,
                  source_publisher: evidenceFeed?.publisher || null,
                  similarity_score: match.similarity,
                  is_independent: isIndependent,
                });

                if (insertErr) {
                  errors.push(`Evidence insert: ${insertErr.message}`);
                } else {
                  totalEvidence++;
                  insertedForClaim++;
                }
              }
            } catch (e) {
              errors.push(`Claim ${claim.id}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      } catch (e) {
        errors.push(`Doc ${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log(`Evidence retrieval: ${totalEvidence} items, ${totalNonIndependent} non-independent, ${totalDeduped} deduped`);
    if (errors.length) console.warn("Evidence errors:", errors);

    return new Response(
      JSON.stringify({
        documents: docs.length,
        claims_processed: totalClaims,
        evidence_found: totalEvidence,
        non_independent: totalNonIndependent,
        deduped: totalDeduped,
        errors: errors.length ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Evidence fatal error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
