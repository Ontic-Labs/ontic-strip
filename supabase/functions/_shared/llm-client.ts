// =============================================================
// Unified LLM chat completion client for Deno edge functions.
// All models routed through OpenRouter.
// =============================================================

import type { LlmRequest, LlmResponse } from "./prompt-types.ts";

const GATEWAY_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

/**
 * Strip markdown code fences from LLM response content.
 * Handles ```json ... ``` and bare ``` ... ``` wrappers.
 */
function cleanJsonResponse(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/g, "")
    .replace(/```\s*$/g, "")
    .trim();
}

/**
 * Unified LLM chat completion caller.
 * Both gateways use the same OpenAI-compatible request shape.
 */
export async function callLlm(request: LlmRequest): Promise<LlmResponse> {
  const url = GATEWAY_URLS[request.gateway];
  if (!url) throw new Error(`Unknown gateway: ${request.gateway}`);

  // deno-lint-ignore no-explicit-any
  const body: Record<string, any> = {
    model: request.model,
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ],
    temperature: request.temperature,
    max_tokens: request.maxTokens,
  };

  if (request.tools) body.tools = request.tools;
  if (request.toolChoice) body.tool_choice = request.toolChoice;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM ${request.gateway} error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const message = data.choices?.[0]?.message;
  const rawContent = message?.content || "";

  // Citations: Perplexity direct API puts them at data.citations,
  // OpenRouter puts them in message.annotations as URL_CITATION objects
  let citations: string[] | undefined;
  if (Array.isArray(data.citations) && data.citations.length > 0) {
    citations = data.citations;
  } else if (Array.isArray(message?.annotations)) {
    const urls = message.annotations
      .filter((a: { type?: string; url_citation?: { url?: string } }) => a.type === "url_citation" && a.url_citation?.url)
      .map((a: { url_citation: { url: string } }) => a.url_citation.url);
    // Deduplicate while preserving order
    citations = [...new Set(urls)] as string[];
    if (citations.length === 0) citations = undefined;
  }

  // Extract tool call arguments if present
  const toolCall = message?.tool_calls?.[0];
  const toolCallArguments = toolCall?.function?.arguments || undefined;

  return {
    content: cleanJsonResponse(rawContent),
    citations,
    toolCallArguments,
    raw: data,
  };
}
