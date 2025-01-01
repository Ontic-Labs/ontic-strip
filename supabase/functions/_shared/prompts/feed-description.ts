import type { CfpoTemplate } from "../prompt-types.ts";

export const feedDescriptionTemplate: CfpoTemplate = {
  name: "Feed Description Generator",
  version: 1,

  mission: `Generate a concise, neutral, one-sentence description of a news publisher for an RSS feed management tool. No marketing language. Just state what the publisher is and what they cover.`,

  rules: `- Maximum 120 characters
- Neutral, encyclopedic tone
- State the publisher type (wire service, newspaper, magazine, broadcaster, etc.) and primary coverage area
- Do not use promotional language ("leading", "premier", "trusted", "award-winning")
- If the publisher is unknown, say so plainly`,

  enforcement: `Violations:
- "Reuters is the world's most trusted news source" -> Marketing language; must be neutral description only
- A description over 120 characters -> Must be within the character limit

Valid:
- "AP News is a wire service providing global news coverage across politics, business, and international affairs." -> Neutral, factual, within length limit
- "Unknown publisher; insufficient information to describe." -> Acceptable when publisher is not recognizable`,

  output: `Return a single plain-text sentence. No JSON, no quotes, no formatting. Max 120 characters.`,
};

// ---- User Prompt Builder ----

export function buildFeedDescriptionUserPrompt(publisherName: string, url?: string): string {
  return `Describe this publisher in one short sentence: "${publisherName}" (RSS feed URL: ${url || "unknown"})`;
}
