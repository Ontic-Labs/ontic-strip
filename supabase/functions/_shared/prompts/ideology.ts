import type { CfpoTemplate } from "../prompt-types.ts";

export const ideologyTemplate: CfpoTemplate = {
  name: "Ideology Classifier",
  version: 1,

  mission: `Classify the ideological positioning of a news article along two axes derived from MBFC methodology:
1. Economic System (-10 to +10): From communism/full government ownership (-10) through regulated market economy (0) to radical laissez-faire capitalism (+10).
2. Social Progressive vs. Traditional Conservative (-10 to +10): From strong progressive liberalism (-10) through balanced (0) to strong traditional conservatism (+10).

Analyze the article's framing, sourcing, word choice, and implicit assumptions — not just its topic. A story about taxes can be framed from any ideological position.`,

  rules: `- Score ONLY the article's framing and editorial positioning, not the topic itself
- A neutral wire report about a progressive policy should score near 0, not negative
- Attribution claims ("Senator X said...") should not shift scores unless the framing endorses the position
- Opinion/editorial pieces will naturally score further from 0 than straight news
- If the article is purely procedural or factual with no discernible ideological lean, score both axes as 0
- Economic axis: focus on stance toward regulation, corporate power, taxation, government spending, market intervention
- Social axis: focus on stance toward social issues (abortion, immigration, LGBTQ+ rights, climate, criminal justice, religion in public life)
- Consider loaded language, story selection bias, source selection, and framing of opposing views
- Do NOT use the publisher's known reputation — analyze THIS article's content only`,

  enforcement: `Violations:
- Scoring based on publisher identity rather than article content → Must analyze the specific text
- Scoring a neutral wire report as -5 because it covers a progressive policy → Topic ≠ framing
- Returning scores outside [-10, +10] → Must be within range

Valid:
- An article sympathetically framing universal healthcare with dismissive language toward market alternatives → economic: -4, social: -3
- A neutral AP report on a tax bill with quotes from both parties → economic: 0, social: 0
- An editorial arguing for deregulation and traditional family values → economic: +5, social: +6`,

  output: `Return a JSON object with exactly this shape:
{
  "economic": <number -10 to +10>,
  "social": <number -10 to +10>,
  "confidence": <number 0 to 1>,
  "reasoning": "<one sentence explaining the key signals>"
}

No markdown fences. No extra fields.`,
};

export function buildIdeologyUserPrompt(title: string, content: string): string {
  // Truncate to ~3000 chars to stay within token limits
  const truncated = content.length > 3000 ? content.slice(0, 3000) + "\n[truncated]" : content;
  return `Classify the ideological positioning of this article:\n\nTitle: ${title}\n\nContent:\n${truncated}`;
}
