// =============================================================
// Prompt registry — versioned manifest of all CFPO templates.
// One entry per prompt. Model config lives here, not in handlers.
// =============================================================

import type { PromptConfig } from "./prompt-types.ts";

export const PROMPT_REGISTRY: Record<string, PromptConfig> = {
  normalizer: {
    key: "normalizer",
    name: "Content Normalizer",
    version: 1,
    status: "active",
    gateway: "openrouter",
    model: "google/gemini-2.5-flash-lite",
    temperature: 0,
    maxTokens: 8192,
    changeSummary: "Initial CFPO extraction from normalizer/index.ts",
  },
  classifier: {
    key: "classifier",
    name: "Segment Classifier",
    version: 1,
    status: "active",
    gateway: "openrouter",
    model: "perplexity/sonar",
    temperature: 0.1,
    maxTokens: 4000,
    changeSummary: "Initial CFPO extraction from oracle-classifier/index.ts",
  },
  extractor: {
    key: "extractor",
    name: "Claim Extractor",
    version: 1,
    status: "active",
    gateway: "openrouter",
    model: "perplexity/sonar",
    temperature: 0.1,
    maxTokens: 16000,
    changeSummary: "Initial CFPO extraction from oracle-extractor/index.ts",
  },
  "veracity-nli": {
    key: "veracity-nli",
    name: "Corpus NLI Scoring",
    version: 1,
    status: "active",
    gateway: "openrouter",
    model: "perplexity/sonar",
    temperature: 0.1,
    maxTokens: 8000,
    changeSummary: "Initial CFPO extraction from oracle-veracity/index.ts (corpus NLI)",
  },
  "veracity-web": {
    key: "veracity-web",
    name: "Web Verification",
    version: 1,
    status: "active",
    gateway: "openrouter",
    model: "perplexity/sonar",
    temperature: 0.1,
    maxTokens: 8000,
    changeSummary: "Initial CFPO extraction from oracle-veracity/index.ts (web verify)",
  },
  sentiment: {
    key: "sentiment",
    name: "Segment Sentiment Scoring",
    version: 1,
    status: "active",
    gateway: "openrouter",
    model: "google/gemini-2.5-flash-lite",
    temperature: 0,
    maxTokens: 4000,
    changeSummary: "Initial CFPO extraction from oracle-sentiment/index.ts",
  },
  synthesis: {
    key: "synthesis",
    name: "Narrative Synthesis",
    version: 1,
    status: "active",
    gateway: "openrouter",
    model: "perplexity/sonar",
    temperature: 0.3,
    maxTokens: 500,
    changeSummary: "Initial CFPO extraction from oracle-synthesis/index.ts",
  },
  "feed-description": {
    key: "feed-description",
    name: "Feed Description Generator",
    version: 1,
    status: "active",
    gateway: "openrouter",
    model: "google/gemini-2.5-flash-lite",
    temperature: 0,
    maxTokens: 256,
    changeSummary: "Initial CFPO extraction from generate-feed-description/index.ts",
  },
  "story-clusterer": {
    key: "story-clusterer",
    name: "Story Cluster Labeler",
    version: 1,
    status: "active",
    gateway: "openrouter",
    model: "google/gemini-2.5-flash-lite",
    temperature: 0,
    maxTokens: 4000,
    changeSummary: "Initial CFPO extraction from story-clusterer/index.ts",
  },
  stance: {
    key: "stance",
    name: "Stance Extractor",
    version: 2,
    status: "active",
    gateway: "openrouter",
    model: "google/gemini-2.5-flash",
    temperature: 0.1,
    maxTokens: 2000,
    changeSummary: "v2: Framing-aware extraction for news; lower retrieval thresholds; fuzzy quote validation",
  },
  "event-classifier": {
    key: "event-classifier",
    name: "Event Type Classifier",
    version: 1,
    status: "active",
    gateway: "openrouter",
    model: "google/gemini-2.5-flash-lite",
    temperature: 0,
    maxTokens: 256,
    changeSummary: "Deterministic event type classification for EventKey generation",
  },
};
export function getPromptConfig(key: string): PromptConfig {
  const entry = PROMPT_REGISTRY[key];
  if (!entry) throw new Error(`Unknown prompt key: "${key}"`);
  if (entry.status !== "active") {
    throw new Error(`Prompt "${key}" is ${entry.status}, not active`);
  }
  return entry;
}
