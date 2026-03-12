// =============================================================
// CFPO v2 type definitions for the Deno edge function runtime.
// Mirrors the @ontic/prompts contract adapted for Supabase.
// =============================================================

// ---- CFPO Template Shape ----

export interface CfpoTemplate {
  /** Human-readable name */
  name: string;
  /** Version number for this template (bump, don't edit in place) */
  version: number;
  /** Optional persona/tone calibration */
  voice?: string;
  /** Required: what this prompt accomplishes */
  mission: string;
  /** Required: constraints, taxonomies, enums */
  rules: string;
  /** Required: paired violation/valid examples */
  enforcement: string;
  /** Required: output format spec (JSON schema + enforcement) */
  output: string;
  /** Template variables this prompt expects (for documentation) */
  variables?: string[];
}

// ---- Prompt Registry Entry ----

export type PromptGateway = "openrouter";
export type PromptStatus = "active" | "draft" | "archived";

export interface PromptConfig {
  key: string;
  name: string;
  version: number;
  status: PromptStatus;
  gateway: PromptGateway;
  model: string;
  temperature: number;
  maxTokens: number;
  changeSummary: string;
}

// ---- Compiled Output ----

export interface CompiledPrompt {
  systemPrompt: string;
  config: PromptConfig;
}

// ---- LLM Client Types ----

export interface LlmRequest {
  gateway: PromptGateway;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  apiKey: string;
  /** OpenAI-compatible tools array for function calling */
  tools?: unknown[];
  /** OpenAI-compatible tool_choice (e.g. { type: "function", function: { name: "..." } }) */
  toolChoice?: unknown;
  /** Optional AbortSignal for timeout control */
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: string;
  citations?: string[];
  /** Raw parsed arguments from the first tool call, if tools were used */
  toolCallArguments?: string;
  raw: Record<string, unknown>;
}
