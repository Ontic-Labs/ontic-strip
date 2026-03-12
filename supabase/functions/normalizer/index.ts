import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { compilePrompt } from "../_shared/prompt-builder.ts";
import { callLlm } from "../_shared/llm-client.ts";
import { normalizerTemplate } from "../_shared/prompts/normalizer.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const FIRECRAWL_API = "https://api.firecrawl.dev/v1";
const FIRECRAWL_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 60_000;
const MAX_INPUT_CHARS = 30_000;
const MIN_SCRAPE_CHARS = 200;
const MIN_CLEANED_CHARS = 100;

async function scrapeToMarkdown(url: string, firecrawlKey: string): Promise<string> {
  const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${firecrawlKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      waitFor: 2000,
    }),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Firecrawl HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const md = data.data?.markdown || data.markdown || "";
  if (md.length < MIN_SCRAPE_CHARS) {
    throw new Error(`Firecrawl returned insufficient content (${md.length} chars)`);
  }
  return md;
}

async function cleanMarkdown(rawMarkdown: string, apiKey: string): Promise<string> {
  const truncated = rawMarkdown.length > MAX_INPUT_CHARS
    ? rawMarkdown.substring(0, MAX_INPUT_CHARS)
    : rawMarkdown;

  const { systemPrompt, config } = compilePrompt("normalizer", normalizerTemplate, {
    PUBLISHER_EXCLUSIONS: "",
  });

  const { content } = await callLlm({
    gateway: config.gateway,
    model: config.model,
    systemPrompt,
    userPrompt: truncated,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    apiKey,
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!content || content.length < MIN_CLEANED_CHARS) {
    throw new Error(`AI cleaning produced insufficient content (${content?.length ?? 0} chars)`);
  }
  return content;
}

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
    const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
    const openrouterApiKey = Deno.env.get("OPENROUTER_API_KEY");

    if (!firecrawlKey) return json({ error: "FIRECRAWL_API_KEY not configured" }, 500);
    if (!openrouterApiKey) return json({ error: "OPENROUTER_API_KEY not configured" }, 500);

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

    // Idempotency: only process if still in normalizing state
    const { data: doc, error: fetchErr } = await supabase
      .from("documents")
      .select("id, url, title")
      .eq("id", documentId)
      .eq("pipeline_status", "normalizing")
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!doc) {
      return json({ skipped: true, message: "Document not in normalizing state (already processed or missing)" });
    }

    // Step 1: Scrape
    console.log(`Scraping: ${doc.url}`);
    const rawMarkdown = await scrapeToMarkdown(doc.url, firecrawlKey);

    // Step 2: Clean with AI
    console.log(`Cleaning: ${doc.title} (${rawMarkdown.length} chars raw)`);
    const cleaned = await cleanMarkdown(rawMarkdown, openrouterApiKey);

    // Step 3: Persist — use pipeline_status guard to prevent double-writes
    const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
    const { data: updated, error: updateErr } = await supabase
      .from("documents")
      .update({
        normalized_content: cleaned,
        word_count: wordCount,
        fetch_status: "normalized",
        pipeline_status: "pending",
      })
      .eq("id", doc.id)
      .eq("pipeline_status", "normalizing")
      .select("id")
      .maybeSingle();

    if (updateErr) {
      return json({ error: `DB update failed: ${updateErr.message}` }, 500);
    }

    if (!updated) {
      return json({ skipped: true, message: "Document status changed during processing (race)" });
    }

    console.log(`Done: ${doc.title} (${wordCount} words)`);
    return json({ normalized: 1, id: doc.id, wordCount });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Normalizer error:", msg);
    return json({ error: msg }, 500);
  }
});
