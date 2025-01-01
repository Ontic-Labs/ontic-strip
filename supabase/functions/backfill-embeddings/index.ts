/**
 * backfill-embeddings — Regenerate embeddings for segments & proposition_bank
 *
 * Processes rows where embedding IS NULL in batches.
 * Uses text-embedding-3-large with 1536 dimensions (Matryoshka truncation).
 *
 * Query params:
 *   ?table=segments|propositions  (default: segments)
 *   ?batch=100                    (rows per invocation, default 100)
 *   ?dry_run=true                 (count only, don't update)
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const EMBEDDING_MODEL = "openai/text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_API_BATCH = 20; // Max texts per API call

async function getEmbeddings(
  texts: string[],
  apiKey: string,
): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);

  for (let i = 0; i < texts.length; i += EMBEDDING_API_BATCH) {
    const batch = texts.slice(i, i + EMBEDDING_API_BATCH);
    try {
      const resp = await fetch(OPENROUTER_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: batch,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });

      if (!resp.ok) {
        console.error(
          `Embedding API error (batch ${i}): ${resp.status} ${await resp.text()}`,
        );
        continue;
      }

      const data = await resp.json();
      for (const item of data.data || []) {
        results[i + item.index] = item.embedding;
      }
    } catch (e) {
      console.error(`Embedding batch ${i} failed:`, e);
    }
  }

  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const table = url.searchParams.get("table") || "segments";
    const batchSize = Math.min(
      Number(url.searchParams.get("batch") || "100"),
      500,
    );
    const dryRun = url.searchParams.get("dry_run") === "true";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Use raw SQL via rpc to find null-embedding rows (vector columns
    // don't always work with .is("embedding", null) in PostgREST).

    if (table === "propositions") {
      // ── Proposition Bank ──
      const { data: rows, error: fetchErr } = await supabase
        .rpc("get_null_embedding_propositions", { row_limit: batchSize });

      if (fetchErr) throw new Error(`proposition fetch: ${fetchErr.message}`);
      if (!rows || rows.length === 0) {
        return json({ table, remaining: 0, processed: 0, message: "All done" });
      }

      if (dryRun) {
        return json({ table, remaining: rows.length, dry_run: true });
      }

      const texts = rows.map((r: any) => r.prop_text);
      const embeddings = await getEmbeddings(texts, openrouterKey);

      let updated = 0;
      const errors: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (!embeddings[i]) continue;
        const { error } = await supabase
          .from("proposition_bank")
          .update({ embedding: `[${embeddings[i]!.join(",")}]` })
          .eq("proposition_id", rows[i].id);
        if (error) {
          errors.push(`prop ${rows[i].id}: ${error.message}`);
        } else {
          updated++;
        }
      }

      return json({ table, processed: rows.length, updated, errors: errors.length ? errors : undefined });
    }

    // ── Segments (default) ──
    const { data: rows, error: fetchErr } = await supabase
      .rpc("get_null_embedding_segments", { row_limit: batchSize });

    if (fetchErr) throw new Error(`segment fetch: ${fetchErr.message}`);
    if (!rows || rows.length === 0) {
      return json({ table, remaining: 0, processed: 0, message: "All done" });
    }

    if (dryRun) {
      return json({ table, remaining: rows.length, dry_run: true });
    }

    const texts = rows.map((r: any) => r.text_content || "");
    const embeddings = await getEmbeddings(texts, openrouterKey);

    let updated = 0;
    const errors: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (!embeddings[i]) continue;
      const { error } = await supabase
        .from("segments")
        .update({ embedding: `[${embeddings[i]!.join(",")}]` })
        .eq("id", rows[i].id);
      if (error) {
        errors.push(`seg ${rows[i].id}: ${error.message}`);
      } else {
        updated++;
      }
    }

    return json({ table, processed: rows.length, updated, errors: errors.length ? errors : undefined });
  } catch (e) {
    console.error("backfill-embeddings error:", e);
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

function json(data: Record<string, unknown>) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
