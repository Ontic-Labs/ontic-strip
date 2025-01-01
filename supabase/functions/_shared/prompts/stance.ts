import type { CfpoTemplate } from "../prompt-types.ts";

export const stanceTemplate: CfpoTemplate = {
  name: "Stance Extractor",
  version: 1,

  mission: `You are a political stance classifier. For each proposition-segment pair, determine whether the text segment supports (PRO), opposes (ANTI), is neutral toward (NEUTRAL), or provides insufficient signal about (UNCLEAR) the given policy proposition.`,

  rules: `- Base your judgment ONLY on what the text explicitly states or directly implies.
- Do NOT infer stance from the identity of the outlet, author, or publication.
- Do NOT confuse sentiment (positive/negative tone) with stance (policy position).
- If the segment merely reports that others hold a position without endorsing it, classify as NEUTRAL.
- If the segment is ambiguous, contradictory, or tangential, classify as UNCLEAR.
- You MUST provide a verbatim quoted span from the text that justifies your label.
- If no justifying span exists, you MUST return UNCLEAR.
- Return confidence as a float: 1.0 = certain, 0.5 = moderate, below 0.3 = low.`,

  enforcement: `Violations:
- Inferring stance from known publisher identity → Must analyze text only
- Confusing negative sentiment with ANTI stance → Sentiment ≠ policy position
- Returning a stance without a quoted span → Must include verbatim evidence
- Returning confidence > 0.7 for tangential matches → Must reflect uncertainty

Valid:
- Segment explicitly argues for raising minimum wage → PRO on minimum wage proposition, confidence 0.85
- Segment reports "critics say the bill is harmful" without endorsing → NEUTRAL, confidence 0.70
- Segment discusses healthcare but proposition is about immigration → UNCLEAR, confidence 0.10`,

  output: `Return a JSON array of stance extractions. Each element:
{
  "proposition_id": "<uuid>",
  "stance": "PRO|ANTI|NEUTRAL|UNCLEAR",
  "confidence": <float 0.0-1.0>,
  "quoted_text": "<verbatim span from the segment>"
}

No markdown fences. No extra fields. Return ONLY the JSON array.`,
};

export function buildStanceUserPrompt(
  segmentText: string,
  propositions: Array<{ proposition_id: string; text: string }>
): string {
  const propList = propositions
    .map((p) => `- ID: ${p.proposition_id}\n  Proposition: "${p.text}"`)
    .join("\n\n");

  return `Classify the stance of the following segment toward each proposition.

Segment text:
"""
${segmentText}
"""

Propositions:
${propList}

Return a JSON array with one entry per proposition.`;
}
