import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// --------------- Minimal Content Cleaning ---------------
// Content arriving from the normalizer is already clean prose.
// Only strip watermark comments and normalize whitespace.

function cleanContent(text: string): string {
  return text
    .replace(/<!--\s*corpus-watermark:[^>]*-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --------------- Sentence Tokenizer ---------------

function splitSentences(text: string): string[] {
  const raw = text.split(/(?<=[.!?])\s+/);
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.33);
}

// --------------- Corpus Watermark ---------------

function computeWatermarkHash(corpusId: string, position: number, text: string): string {
  const input = `${corpusId}:${position}:${text.substring(0, 64)}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, "0").substring(0, 16);
}

// --------------- Front Matter Generation ---------------

interface CorpusFrontMatter {
  corpus_id: string;
  title: string | null;
  tier: string;
  version: number;
  content_type: string;
  source_url: string;
  source_publisher: string;
  source_category: string;
  published_at: string | null;
  language: string;
  fact_check: {
    status: string;
    checked_at: string | null;
    checked_by: string | null;
  };
  sire: {
    subject: string | null;
    included: string[];
    excluded: string[];
    relevant: string[];
  };
}

function generateFrontMatter(doc: any, feed: any): CorpusFrontMatter {
  const tierMap: Record<string, string> = {
    mainstream: "tier_4",
    partisan: "tier_4",
    fringe: "tier_5",
    reference: "tier_3",
    wire: "tier_2",
  };

  return {
    corpus_id: doc.id,
    title: doc.title,
    tier: tierMap[feed?.source_category] || "tier_5",
    version: 1,
    content_type: "prose",
    source_url: doc.url,
    source_publisher: feed?.publisher_name || "Unknown",
    source_category: feed?.source_category || "mainstream",
    published_at: doc.published_at,
    language: "english",
    fact_check: {
      status: "pending",
      checked_at: null,
      checked_by: null,
    },
    sire: {
      subject: null,
      included: [],
      excluded: [],
      relevant: [],
    },
  };
}

// --------------- Deterministic Chunking ---------------

interface Chunk {
  text: string;
  watermarked_text: string;
  tokenCount: number;
  position: number;
}

function chunkDocument(normalizedText: string, corpusId: string): Chunk[] {
  const cleaned = cleanContent(normalizedText);
  const paragraphs = cleaned.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: Chunk[] = [];
  let position = 0;

  for (const para of paragraphs) {
    const sentences = splitSentences(para);
    let buffer: string[] = [];
    let bufferTokens = 0;

    for (const sentence of sentences) {
      const sentTokens = estimateTokens(sentence);

      if (bufferTokens + sentTokens > 200 && bufferTokens >= 80) {
        const text = buffer.join(" ");
        const hash = computeWatermarkHash(corpusId, position, text);
        chunks.push({
          text,
          watermarked_text: `${text}\n\n<!-- corpus-watermark:v1:${corpusId}:${position}:${hash} -->`,
          tokenCount: bufferTokens,
          position: position++,
        });
        buffer = [];
        bufferTokens = 0;
      }

      buffer.push(sentence);
      bufferTokens += sentTokens;
    }

    if (buffer.length > 0) {
      if (bufferTokens < 50 && chunks.length > 0 && chunks[chunks.length - 1].tokenCount < 180) {
        const prev = chunks[chunks.length - 1];
        const mergedText = prev.text + " " + buffer.join(" ");
        prev.text = mergedText;
        prev.tokenCount += bufferTokens;
        const hash = computeWatermarkHash(corpusId, prev.position, mergedText);
        prev.watermarked_text = `${mergedText}\n\n<!-- corpus-watermark:v1:${corpusId}:${prev.position}:${hash} -->`;
      } else {
        const text = buffer.join(" ");
        const hash = computeWatermarkHash(corpusId, position, text);
        chunks.push({
          text,
          watermarked_text: `${text}\n\n<!-- corpus-watermark:v1:${corpusId}:${position}:${hash} -->`,
          tokenCount: bufferTokens,
          position: position++,
        });
      }
    }
  }

  const MIN_CHUNK_TOKENS = 30;
  const filtered = chunks.filter((c) => c.tokenCount >= MIN_CHUNK_TOKENS);

  return filtered.map((c, idx) => {
    if (c.position !== idx) {
      const hash = computeWatermarkHash(corpusId, idx, c.text);
      return {
        ...c,
        position: idx,
        watermarked_text: `${c.text}\n\n<!-- corpus-watermark:v1:${corpusId}:${idx}:${hash} -->`,
      };
    }
    return c;
  });
}

// --------------- OpenRouter Embedding ---------------

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const EMBEDDING_MODEL = "openai/text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 1536; // Matryoshka truncation — fits existing vector(1536) columns
const EMBEDDING_BATCH_SIZE = 20;

async function getEmbeddings(texts: string[], apiKey: string): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);

    try {
      const resp = await fetch(OPENROUTER_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch, dimensions: EMBEDDING_DIMENSIONS }),
      });

      if (!resp.ok) {
        console.error(`Embedding API error (batch ${i}): ${resp.status} ${await resp.text()}`);
        continue;
      }

      const data = await resp.json();
      for (const item of (data.data || [])) {
        results[i + item.index] = item.embedding;
      }
    } catch (e) {
      console.error(`Embedding batch ${i} failed:`, e);
    }
  }

  return results;
}

// --------------- Build Embedding Input with Front Matter Context ---------------

function buildEmbeddingInput(chunk: Chunk, frontMatter: CorpusFrontMatter): string {
  const context = [
    `[publisher: ${frontMatter.source_publisher}`,
    `category: ${frontMatter.source_category}`,
    `tier: ${frontMatter.tier}`,
    frontMatter.published_at ? `date: ${frontMatter.published_at.split("T")[0]}` : null,
    `corpus: ${frontMatter.corpus_id}]`,
  ].filter(Boolean).join(" | ");

  return `${context}\n${chunk.text}`;
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
    let batchSize = 10;
    try {
      const body = await req.json();
      documentId = body.document_id || null;
      batchSize = body.batch_size || 10;
    } catch {
      // No body — process all pending
    }

    // Find documents ready for indexing
    let query = supabase
      .from("documents")
      .select("id, feed_id, url, title, published_at, normalized_content, feeds(publisher_name, source_category)")
      .in("fetch_status", ["normalized", "fetched"])
      .eq("pipeline_status", "pending")
      .not("normalized_content", "is", null)
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (documentId) {
      query = supabase
        .from("documents")
        .select("id, feed_id, url, title, published_at, normalized_content, feeds(publisher_name, source_category)")
        .eq("id", documentId)
        .limit(1);
    }

    const { data: docs, error: docsErr } = await query;
    if (docsErr) throw docsErr;
    if (!docs || docs.length === 0) {
      return new Response(
        JSON.stringify({ indexed: 0, message: "No documents to index" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalSegments = 0;
    let totalEmbedded = 0;
    const errors: string[] = [];

    for (const doc of docs) {
      try {
        if (!doc.normalized_content) continue;

        await supabase
          .from("documents")
          .update({ pipeline_status: "indexing" })
          .eq("id", doc.id);

        const feed = doc.feeds as any;

        // Generate front matter
        const frontMatter = generateFrontMatter(doc, feed);

        // Store front matter on document
        await supabase
          .from("documents")
          .update({ corpus_front_matter: frontMatter } as any)
          .eq("id", doc.id);

        // Chunk with watermarks
        const chunks = chunkDocument(doc.normalized_content, doc.id);
        if (chunks.length === 0) {
          await supabase
            .from("documents")
            .update({ pipeline_status: "failed" })
            .eq("id", doc.id);
          errors.push(`Doc ${doc.id}: no chunks produced`);
          continue;
        }

        // Build embedding inputs with front matter context prepended
        const embeddingInputs = chunks.map((c) => buildEmbeddingInput(c, frontMatter));
        const embeddings = await getEmbeddings(embeddingInputs, openrouterKey);

        // Build segment rows — text_content stores watermarked text
        const segmentRows = chunks.map((chunk, idx) => ({
          document_id: doc.id,
          text_content: chunk.watermarked_text,
          position_index: chunk.position,
          token_count: chunk.tokenCount,
          embedding: embeddings[idx] ? `[${embeddings[idx]!.join(",")}]` : null,
          classification: null,
          label: null,
          rhetorical_flags: [],
        }));

        // Delete existing segments for re-index support
        await supabase.from("segments").delete().eq("document_id", doc.id);

        // Insert in batches
        for (let i = 0; i < segmentRows.length; i += 50) {
          const batch = segmentRows.slice(i, i + 50);
          const { error: insertErr } = await supabase.from("segments").insert(batch);
          if (insertErr) {
            errors.push(`Doc ${doc.id} segments batch ${i}: ${insertErr.message}`);
          }
        }

        totalSegments += chunks.length;
        totalEmbedded += embeddings.filter(Boolean).length;

        await supabase
          .from("documents")
          .update({ pipeline_status: "classifying" })
          .eq("id", doc.id);
      } catch (e) {
        errors.push(`Doc ${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
        await supabase
          .from("documents")
          .update({ pipeline_status: "failed" })
          .eq("id", doc.id);
      }
    }

    console.log(`Indexer complete: ${docs.length} docs, ${totalSegments} segments, ${totalEmbedded} embedded`);
    if (errors.length) console.warn("Indexer errors:", errors);

    return new Response(
      JSON.stringify({
        indexed: docs.length,
        segments: totalSegments,
        embedded: totalEmbedded,
        errors: errors.length ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Indexer fatal error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
