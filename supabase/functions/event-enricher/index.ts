import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { compilePrompt } from "../_shared/prompt-builder.ts";
import { callLlm } from "../_shared/llm-client.ts";
import { eventClassifierTemplate, buildEventClassifierPrompt } from "../_shared/prompts/event-classifier.ts";
import {
  normalizeGeo,
  deduplicateEntities,
  floorToTimeBucket,
  jaccardSimilarity,
} from "../_shared/entity-normalization.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const ALGO_VERSION = 1;

// Crosswalk scoring weights
const W_DOC_SIM = 0.55;
const W_ENTITY_JACCARD = 0.30;
const W_GEO = 0.10;
const W_EVENT_TYPE = 0.05;

// Thresholds
const CROSSWALK_SCORE_THRESHOLD = 0.55;
const CROSSWALK_ENTITY_MIN = 0.10;
const CROSSWALK_TIME_WINDOW_HOURS = 72;

/**
 * Compute SHA-256 EventKey from canonical inputs.
 */
async function computeEventKey(
  eventType: string,
  geoPrimary: string,
  timeBucket: string,
  topEntities: string[],
): Promise<string> {
  const input = `${eventType}|${geoPrimary}|${timeBucket}|${topEntities.sort().join(",")}`;
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute the mean of multiple embedding vectors.
 */
function meanEmbedding(embeddings: number[][]): number[] | null {
  if (embeddings.length === 0) return null;
  const dim = embeddings[0].length;
  const result = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    result[i] /= embeddings.length;
  }
  return result;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let documentId: string | null = null;
    let batchSize = 5;
    try {
      const body = await req.json();
      documentId = body.document_id || null;
      batchSize = body.batch_size || 5;
    } catch { /* no body */ }

    // Find documents ready for enrichment
    let query = supabase
      .from("documents")
      .select("id, title, published_at, feed_id")
      .eq("pipeline_status", "aggregated")
      .is("event_key", null)
      .not("strip", "is", null)
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (documentId) {
      query = supabase
        .from("documents")
        .select("id, title, published_at, feed_id")
        .eq("id", documentId)
        .limit(1);
    }

    const { data: docs, error: docsErr } = await query;
    if (docsErr) throw docsErr;
    if (!docs || docs.length === 0) {
      return new Response(
        JSON.stringify({ enriched: 0, message: "No documents to enrich" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let totalEnriched = 0;
    const errors: string[] = [];

    for (const doc of docs) {
      try {
        // 1) Aggregate entities, geo, and topics from claim-level SIRE data
        const { data: claims } = await supabase
          .from("claims")
          .select("sire_scope, sire_information")
          .eq("document_id", doc.id);

        if (!claims || claims.length === 0) {
          // No claims → still compute basic event_key from title
          await supabase.from("documents").update({
            enriched_entities: [],
            enriched_geo: "unknown",
            enriched_event_type: "ANALYSIS",
            event_key: await computeEventKey(
              "ANALYSIS",
              "unknown",
              floorToTimeBucket(new Date(doc.published_at || Date.now())),
              [],
            ),
          }).eq("id", doc.id);
          totalEnriched++;
          continue;
        }

        // Aggregate all entities from claims
        const allEntities: string[] = [];
        const allTopics: string[] = [];
        const allGeos: string[] = [];

        for (const claim of claims) {
          const scope = claim.sire_scope as { entities?: string[]; topics?: string[] } | null;
          const info = claim.sire_information as { geography?: string } | null;

          if (scope?.entities) allEntities.push(...scope.entities);
          if (scope?.topics) allTopics.push(...scope.topics);
          if (info?.geography) allGeos.push(info.geography);
        }

        // Deduplicate and normalize
        const topEntities = deduplicateEntities(allEntities, 5);
        const topTopics = deduplicateEntities(allTopics, 10);

        // Primary geo: most frequent normalized geo
        const geoCounts = new Map<string, number>();
        for (const g of allGeos) {
          const norm = normalizeGeo(g);
          geoCounts.set(norm, (geoCounts.get(norm) || 0) + 1);
        }
        const geoPrimary = geoCounts.size > 0
          ? [...geoCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
          : "unknown";

        // 2) Classify event type via LLM (cheap flash-lite call)
        let eventType = "OTHER";
        try {
          const { systemPrompt, config } = compilePrompt("event-classifier", eventClassifierTemplate);
          const { content } = await callLlm({
            gateway: config.gateway,
            model: config.model,
            systemPrompt,
            userPrompt: buildEventClassifierPrompt(doc.title || "Untitled", topTopics),
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            apiKey: Deno.env.get("OPENROUTER_API_KEY") || serviceRoleKey,
          });
          const parsed = JSON.parse(content);
          if (parsed.event_type) eventType = parsed.event_type;
        } catch (e) {
          console.warn(`Event classification failed for ${doc.id}, defaulting to OTHER:`, e);
        }

        // 3) Compute EventKey
        const timeBucket = floorToTimeBucket(new Date(doc.published_at || Date.now()));
        const eventKey = await computeEventKey(eventType, geoPrimary, timeBucket, topEntities);

        // 4) Update document with enriched data
        await supabase.from("documents").update({
          enriched_entities: topEntities,
          enriched_geo: geoPrimary,
          enriched_event_type: eventType,
          event_key: eventKey,
        }).eq("id", doc.id);

        // 5) Event matching: try EventKey first, then crosswalk
        // Check if event_key already exists (re-check after potential race)
        let existingEvent: { id: string } | null = null;
        {
          const { data } = await supabase
            .from("events")
            .select("id")
            .eq("event_key", eventKey)
            .limit(1)
            .maybeSingle();
          existingEvent = data;
        }

        if (existingEvent) {
          // Direct EventKey match — attach to existing event
          await supabase.from("documents").update({ event_id: existingEvent.id }).eq("id", doc.id);
          const { count: docCount } = await supabase.from("documents").select("id", { count: "exact", head: true }).eq("event_id", existingEvent.id);
          await supabase.from("events").update({
            document_count: docCount ?? 1,
            cluster_entities: topEntities,
          }).eq("id", existingEvent.id);

          console.log(`Doc ${doc.id}: EventKey match → event ${existingEvent.id}`);
          totalEnriched++;
          continue;
        }

        // 6) Crosswalk: semantic + SIRE overlap fallback
        // Get doc embedding (average of first 3 segment embeddings)
        const { data: segEmbeddings } = await supabase
          .from("segments")
          .select("embedding")
          .eq("document_id", doc.id)
          .not("embedding", "is", null)
          .order("position_index", { ascending: true })
          .limit(3);

        let docEmbedding: number[] | null = null;
        if (segEmbeddings && segEmbeddings.length > 0) {
          const embeddings = segEmbeddings
            .map(s => {
              if (typeof s.embedding === "string") {
                try { return JSON.parse(s.embedding); } catch { return null; }
              }
              return s.embedding;
            })
            .filter((e): e is number[] => Array.isArray(e));
          docEmbedding = meanEmbedding(embeddings);
        }

        let matchedEventId: string | null = null;

        if (docEmbedding) {
          // Search for candidate events within time window
          const pubDate = new Date(doc.published_at || Date.now());
          const timeStart = new Date(pubDate.getTime() - CROSSWALK_TIME_WINDOW_HOURS * 3600000).toISOString();
          const timeEnd = new Date(pubDate.getTime() + CROSSWALK_TIME_WINDOW_HOURS * 3600000).toISOString();

          const { data: candidates } = await supabase.rpc("match_event_centroids", {
            query_embedding: JSON.stringify(docEmbedding),
            time_start: timeStart,
            time_end: timeEnd,
            match_count: 50,
            match_threshold: 0.4,
          });

          if (candidates && candidates.length > 0) {
            // Score each candidate
            let bestScore = 0;
            let bestCandidate: typeof candidates[0] | null = null;
            let bestJaccard = 0;

            for (const c of candidates) {
              const simDoc = c.similarity;
              const jEntities = jaccardSimilarity(topEntities, c.entities || []);
              const simGeo = c.geo_primary === geoPrimary ? 1 : 0;
              const simEventType = c.event_type === eventType ? 1 : (c.event_type !== "OTHER" && eventType !== "OTHER" ? 0.5 : 0);

              const score = W_DOC_SIM * simDoc + W_ENTITY_JACCARD * jEntities + W_GEO * simGeo + W_EVENT_TYPE * simEventType;

              if (score > bestScore) {
                bestScore = score;
                bestCandidate = c;
                bestJaccard = jEntities;
              }
            }

            if (bestCandidate && bestScore >= CROSSWALK_SCORE_THRESHOLD && bestJaccard >= CROSSWALK_ENTITY_MIN) {
              matchedEventId = bestCandidate.event_id;
              console.log(`Doc ${doc.id}: Crosswalk match → event ${matchedEventId} (score=${bestScore.toFixed(3)}, jaccard=${bestJaccard.toFixed(3)})`);
            }
          }
        }

        if (matchedEventId) {
          // Attach to existing event
          await supabase.from("documents").update({ event_id: matchedEventId }).eq("id", doc.id);

          // Update event centroid (running average)
          if (docEmbedding) {
            const { data: eventData } = await supabase.from("events").select("doc_centroid, document_count, cluster_entities").eq("id", matchedEventId).single();
            if (eventData) {
              const existingCount = eventData.document_count || 1;
              const existingCentroid = typeof eventData.doc_centroid === "string"
                ? JSON.parse(eventData.doc_centroid)
                : eventData.doc_centroid;

              let newCentroid = docEmbedding;
              if (existingCentroid && Array.isArray(existingCentroid)) {
                // Running average: new = (old * count + new) / (count + 1)
                newCentroid = existingCentroid.map((v: number, i: number) =>
                  (v * existingCount + docEmbedding![i]) / (existingCount + 1)
                );
              }

              // Merge entities
              const mergedEntities = deduplicateEntities(
                [...(eventData.cluster_entities || []), ...topEntities],
                10,
              );

              await supabase.from("events").update({
                doc_centroid: JSON.stringify(newCentroid),
                document_count: existingCount + 1,
                cluster_entities: mergedEntities,
              }).eq("id", matchedEventId);
            }
          }
        } else {
          // Create new event (handle race with upsert-like pattern)
          const { data: newEvent, error: eventErr } = await supabase.from("events").insert({
            event_key: eventKey,
            event_type: eventType,
            geo_primary: geoPrimary,
            time_bucket: timeBucket,
            entities: topEntities,
            topics: topTopics,
            title: doc.title,
            doc_centroid: docEmbedding ? JSON.stringify(docEmbedding) : null,
            cluster_entities: topEntities,
            algo_version: ALGO_VERSION,
            document_count: 1,
          }).select("id").single();

          if (eventErr && eventErr.message.includes("duplicate key")) {
            // Race condition: another doc created this event first, re-fetch and attach
            const { data: raceEvent } = await supabase.from("events").select("id").eq("event_key", eventKey).maybeSingle();
            if (raceEvent) {
              await supabase.from("documents").update({ event_id: raceEvent.id }).eq("id", doc.id);
              const { count: docCount } = await supabase.from("documents").select("id", { count: "exact", head: true }).eq("event_id", raceEvent.id);
              await supabase.from("events").update({ document_count: docCount ?? 1 }).eq("id", raceEvent.id);
              console.log(`Doc ${doc.id}: Race-resolved → event ${raceEvent.id}`);
            }
          } else if (eventErr) {
            errors.push(`Doc ${doc.id}: event insert failed: ${eventErr.message}`);
          } else if (newEvent) {
            await supabase.from("documents").update({ event_id: newEvent.id }).eq("id", doc.id);
            console.log(`Doc ${doc.id}: New event ${newEvent.id} (type=${eventType}, geo=${geoPrimary}, entities=${topEntities.join(",")})`);
          }
        }

        totalEnriched++;
      } catch (e) {
        errors.push(`Doc ${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log(`Enricher complete: ${totalEnriched} documents`);
    if (errors.length) console.warn("Enricher errors:", errors);

    return new Response(
      JSON.stringify({
        enriched: totalEnriched,
        errors: errors.length ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("Enricher fatal error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
