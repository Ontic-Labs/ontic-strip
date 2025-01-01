import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { compilePrompt } from "../_shared/prompt-builder.ts";
import { callLlm } from "../_shared/llm-client.ts";
import {
  storyClustererTemplate,
  clusterLabelTool,
  clusterLabelToolChoice,
  buildClusterLabelUserPrompt,
} from "../_shared/prompts/story-clusterer.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// --------------- Config ---------------
const SIMILARITY_THRESHOLD = 0.60;
const MIN_CLUSTER_SIZE = 2;
const MAX_CLUSTER_SIZE = 15;
const TIME_WINDOW_HOURS = 72;
const MAX_SEGMENTS_PER_DOC = 3;
const PAIRWISE_DENSITY_MIN = 0.35; // fraction of pairs that must exceed threshold

// --------------- Cosine similarity for averaged embeddings ---------------

function parseEmbedding(raw: string): number[] {
  // Embeddings are stored as pgvector string "[0.1,0.2,...]"
  if (typeof raw !== "string") return [];
  const cleaned = raw.replace(/[\[\]]/g, "");
  return cleaned.split(",").map(Number);
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const avg = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) avg[i] += emb[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= embeddings.length;
  return avg;
}

// --------------- Pairwise density clustering ---------------
// Instead of connected components (transitive), we use a greedy
// density-based approach: for each candidate cluster, verify that
// a minimum fraction of all pairwise similarities exceed the threshold.

interface DocEmb {
  docId: string;
  embedding: number[];
}

function buildClusters(docs: DocEmb[]): string[][] {
  const n = docs.length;
  if (n < 2) return [];

  // Pre-compute similarity matrix
  const simMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSim(docs[i].embedding, docs[j].embedding);
      simMatrix[i][j] = sim;
      simMatrix[j][i] = sim;
    }
  }

  // Build adjacency based on threshold
  const neighbors: Map<number, number[]> = new Map();
  for (let i = 0; i < n; i++) {
    const adj: number[] = [];
    for (let j = 0; j < n; j++) {
      if (i !== j && simMatrix[i][j] >= SIMILARITY_THRESHOLD) {
        adj.push(j);
      }
    }
    neighbors.set(i, adj);
  }

  // Greedy clustering: start from doc with most neighbors
  const assigned = new Set<number>();
  const clusters: number[][] = [];

  const sortedByDegree = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (neighbors.get(b)?.length ?? 0) - (neighbors.get(a)?.length ?? 0));

  for (const seed of sortedByDegree) {
    if (assigned.has(seed)) continue;
    const seedNeighbors = (neighbors.get(seed) ?? []).filter(j => !assigned.has(j));
    if (seedNeighbors.length < MIN_CLUSTER_SIZE - 1) continue;

    // Start cluster with seed
    const cluster = [seed];
    const candidates = [...seedNeighbors].sort((a, b) => simMatrix[seed][b] - simMatrix[seed][a]);

    for (const cand of candidates) {
      if (assigned.has(cand)) continue;
      if (cluster.length >= MAX_CLUSTER_SIZE) break;

      // Check pairwise density: cand must be similar to enough existing members
      let pairsAbove = 0;
      for (const member of cluster) {
        if (simMatrix[cand][member] >= SIMILARITY_THRESHOLD) pairsAbove++;
      }
      const density = pairsAbove / cluster.length;
      if (density >= PAIRWISE_DENSITY_MIN) {
        cluster.push(cand);
      }
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) {
      for (const idx of cluster) assigned.add(idx);
      clusters.push(cluster);
    }
  }

  return clusters.map(c => c.map(idx => docs[idx].docId));
}

// --------------- Main Handler ---------------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openrouterApiKey = Deno.env.get("OPENROUTER_API_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Get recent completed documents within the time window
    const cutoff = new Date(Date.now() - TIME_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const { data: docs, error: docsErr } = await supabase
      .from("documents")
      .select("id, title, feed_id, published_at")
      .in("pipeline_status", ["aggregated", "complete"])
      .gte("published_at", cutoff)
      .order("published_at", { ascending: false })
      .limit(200);

    if (docsErr) throw docsErr;
    if (!docs || docs.length < 2) {
      return new Response(
        JSON.stringify({ clusters: 0, message: "Not enough recent documents" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Get multiple segment embeddings per document (first N segments)
    const docIds = docs.map((d: any) => d.id);
    const { data: segments } = await supabase
      .from("segments")
      .select("document_id, position_index, embedding")
      .in("document_id", docIds)
      .lt("position_index", MAX_SEGMENTS_PER_DOC)
      .not("embedding", "is", null)
      .order("position_index", { ascending: true });

    if (!segments || segments.length < 2) {
      return new Response(
        JSON.stringify({ clusters: 0, message: "Not enough embeddings" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Build averaged embedding per document
    const docSegEmbeddings = new Map<string, number[][]>();
    for (const seg of segments) {
      const parsed = parseEmbedding(seg.embedding);
      if (parsed.length === 0) continue;
      const existing = docSegEmbeddings.get(seg.document_id) ?? [];
      existing.push(parsed);
      docSegEmbeddings.set(seg.document_id, existing);
    }

    const docEmbs: DocEmb[] = [];
    for (const [docId, embeddings] of docSegEmbeddings) {
      const avg = averageEmbeddings(embeddings);
      if (avg.length > 0) {
        docEmbs.push({ docId, embedding: avg });
      }
    }

    if (docEmbs.length < 2) {
      return new Response(
        JSON.stringify({ clusters: 0, message: "Not enough doc embeddings" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Clustering ${docEmbs.length} documents (${TIME_WINDOW_HOURS}h window, threshold=${SIMILARITY_THRESHOLD})`);

    // 4. Build clusters using pairwise density approach
    const protoClusters = buildClusters(docEmbs);

    if (protoClusters.length === 0) {
      // Clear stale clusters
      await supabase.from("story_cluster_members").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("story_clusters").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      return new Response(
        JSON.stringify({ clusters: 0, message: "No clusters found above threshold" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Use AI to generate cluster titles and summaries
    const docTitles = new Map(docs.map((d: any) => [d.id, d.title]));

    const clusterInputs = protoClusters.map((cluster, i) => ({
      clusterIndex: i + 1,
      titles: cluster.map(id => (docTitles.get(id) as string) ?? "Untitled"),
    }));

    const { systemPrompt, config } = compilePrompt("story-clusterer", storyClustererTemplate);
    let clusterLabels: Array<{ index: number; title: string; summary: string }> = [];
    try {
      const result = await callLlm({
        gateway: config.gateway,
        model: config.model,
        systemPrompt,
        userPrompt: buildClusterLabelUserPrompt(clusterInputs),
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        apiKey: openrouterApiKey,
        tools: [clusterLabelTool],
        toolChoice: clusterLabelToolChoice,
      });

      if (result.toolCallArguments) {
        const parsed = JSON.parse(result.toolCallArguments);
        clusterLabels = parsed.clusters;
      }
    } catch (e) {
      console.error("AI cluster labeling failed:", e);
    }

    // 6. Clear old clusters and write new ones
    await supabase.from("story_cluster_members").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    await supabase.from("story_clusters").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    let clustersCreated = 0;
    for (let i = 0; i < protoClusters.length; i++) {
      const cluster = protoClusters[i];
      const label = clusterLabels.find(l => l.index === i + 1);
      const title = label?.title ?? `Story Cluster ${i + 1}`;
      const summary = label?.summary ?? null;

      const { data: inserted, error: insertErr } = await supabase
        .from("story_clusters")
        .insert({ title, summary })
        .select("id")
        .single();

      if (insertErr || !inserted) {
        console.error("Insert cluster error:", insertErr);
        continue;
      }

      // Compute per-member similarity scores (avg similarity to other members)
      const memberEmbs = cluster.map(id => docEmbs.find(d => d.docId === id)!).filter(Boolean);
      const members = cluster.map((docId, idx) => {
        let totalSim = 0;
        let count = 0;
        for (let j = 0; j < memberEmbs.length; j++) {
          if (cluster[j] === docId) continue;
          totalSim += cosineSim(memberEmbs[idx]?.embedding ?? [], memberEmbs[j]?.embedding ?? []);
          count++;
        }
        return {
          cluster_id: inserted.id,
          document_id: docId,
          similarity_score: count > 0 ? totalSim / count : null,
        };
      });

      await supabase.from("story_cluster_members").insert(members);
      clustersCreated++;
    }

    console.log(`Story clusterer: ${clustersCreated} clusters from ${docEmbs.length} docs (${protoClusters.map(c => c.length).join(",")} sizes)`);

    return new Response(
      JSON.stringify({
        clusters: clustersCreated,
        total_documents: docEmbs.length,
        cluster_sizes: protoClusters.map(c => c.length),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Story clusterer error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
