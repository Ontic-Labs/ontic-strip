import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { compilePrompt } from "../_shared/prompt-builder.ts";
import { callLlm } from "../_shared/llm-client.ts";
import { feedDescriptionTemplate, buildFeedDescriptionUserPrompt } from "../_shared/prompts/feed-description.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { publisher_name, url } = await req.json();
    if (!publisher_name) throw new Error("publisher_name required");

    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");

    const { systemPrompt, config } = compilePrompt("feed-description", feedDescriptionTemplate);
    const { content } = await callLlm({
      gateway: config.gateway,
      model: config.model,
      systemPrompt,
      userPrompt: buildFeedDescriptionUserPrompt(publisher_name, url),
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      apiKey,
    });

    return new Response(JSON.stringify({ description: content || null }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-feed-description error:", e);
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("429") ? 429 : msg.includes("402") ? 402 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
