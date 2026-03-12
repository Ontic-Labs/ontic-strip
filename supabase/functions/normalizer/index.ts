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
const BATCH_SIZE = 5;

async function scrapeToMarkdown(url: string, firecrawlKey: string): Promise<string | null> {
  try {
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
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Firecrawl failed for ${url}: HTTP ${resp.status} - ${errText}`);
      return null;
    }

    const data = await resp.json();
    return data.data?.markdown || data.markdown || null;
  } catch (e) {
    console.error(`Firecrawl error for ${url}:`, e);
    return null;
  }
}

async function cleanMarkdown(rawMarkdown: string, apiKey: string): Promise<string | null> {
  const truncated = rawMarkdown.length > 30000 ? rawMarkdown.substring(0, 30000) : rawMarkdown;

  try {
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
    });

    return content || null;
  } catch (e) {
    console.error("AI cleaning failed:", e);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
    const openrouterApiKey = Deno.env.get("OPENROUTER_API_KEY");
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    if (!firecrawlKey) {
      return new Response(
        JSON.stringify({ error: "FIRECRAWL_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!openrouterApiKey) {
      return new Response(
        JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let documentId: string | null = null;
    let batchSize = BATCH_SIZE;
    try {
      const body = await req.json();
      documentId = body.document_id || null;
      batchSize = body.batch_size || BATCH_SIZE;
    } catch {
      // No body
    }

    // If called with a specific document_id (from Graphile worker), process only that doc
    // Otherwise fall back to batch pickup (for manual/cron invocation)
    let docs: Array<{ id: string; url: string; title: string }>;
    if (documentId) {
      const { data, error } = await supabase
        .from("documents")
        .select("id, url, title")
        .eq("id", documentId)
        .eq("pipeline_status", "normalizing")
        .limit(1);
      if (error) throw error;
      docs = data || [];
    } else {
      const { data, error } = await supabase
        .from("documents")
        .select("id, url, title")
        .eq("pipeline_status", "normalizing")
        .order("created_at", { ascending: true })
        .limit(batchSize);
      if (error) throw error;
      docs = data || [];
    }

    if (docs.length === 0) {
      return new Response(
        JSON.stringify({ normalized: 0, message: "No documents to normalize" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalNormalized = 0;
    const errors: string[] = [];

    for (const doc of docs) {
      try {
        // Step 1: Scrape with Firecrawl
        console.log(`Scraping: ${doc.url}`);
        const rawMarkdown = await scrapeToMarkdown(doc.url, firecrawlKey);

        if (!rawMarkdown || rawMarkdown.length < 200) {
          errors.push(`Doc ${doc.id}: Firecrawl returned insufficient content (${rawMarkdown?.length || 0} chars)`);
          await supabase
            .from("documents")
            .update({ pipeline_status: "failed" })
            .eq("id", doc.id);
          continue;
        }

        // Step 2: Clean with AI
        console.log(`Cleaning: ${doc.title} (${rawMarkdown.length} chars raw)`);
        const cleaned = await cleanMarkdown(rawMarkdown, openrouterApiKey);

        if (!cleaned || cleaned.length < 100) {
          errors.push(`Doc ${doc.id}: AI cleaning produced insufficient content`);
          await supabase
            .from("documents")
            .update({ pipeline_status: "failed" })
            .eq("id", doc.id);
          continue;
        }

        const wordCount = cleaned.split(/\s+/).filter(Boolean).length;

        const { error: updateErr } = await supabase
          .from("documents")
          .update({
            normalized_content: cleaned,
            word_count: wordCount,
            fetch_status: "normalized",
            pipeline_status: "pending",
          })
          .eq("id", doc.id);

        if (updateErr) {
          errors.push(`Doc ${doc.id}: status update failed: ${updateErr.message}`);
          continue;
        }

        totalNormalized++;
        console.log(`Done: ${doc.title} (${wordCount} words)`);
      } catch (e) {
        errors.push(`Doc ${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
        await supabase
          .from("documents")
          .update({ pipeline_status: "failed" })
          .eq("id", doc.id);
      }
    }

    console.log(`Normalizer complete: ${totalNormalized}/${docs.length} docs`);
    if (errors.length) console.warn("Normalizer errors:", errors);

    return new Response(
      JSON.stringify({
        normalized: totalNormalized,
        processed: docs.length,
        errors: errors.length ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Normalizer fatal error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
