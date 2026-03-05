import type { CfpoTemplate } from "../prompt-types.ts";

export const stanceTemplate: CfpoTemplate = {
  name: "Stance Extractor",
  version: 2,

  mission: `You are a political stance classifier analyzing news text. For each proposition-segment pair, determine whether the text segment supports (PRO), opposes (ANTI), is genuinely balanced toward (NEUTRAL), or provides insufficient signal about (UNCLEAR) the given policy proposition.

News articles reveal ideological stance not only through explicit advocacy but also through FRAMING — the choices journalists and editors make about source selection, emphasis, language, proportion, and omission. Your task is to detect these framing signals.`,

  rules: `- Base your judgment on both explicit statements AND implicit framing signals in the text.
- Do NOT infer stance from the identity of the outlet, author, or publication.
- Do NOT confuse sentiment (positive/negative tone) with stance (policy position).
- NEUTRAL means genuinely balanced treatment: roughly equal voice given to both sides, or purely procedural content with no framing lean. Reporting that quotes sources from only one side is NOT neutral.
- UNCLEAR means the segment is genuinely off-topic, ambiguous, or contradictory relative to the proposition.

Framing signals that indicate stance (not exhaustive):
  - SOURCE SELECTION: Quoting 3 proponents and 1 critic → PRO lean. Relying on think tanks or advocacy groups aligned with one side.
  - LANGUAGE: "Tax relief" vs "tax cuts"; "undocumented immigrants" vs "illegal aliens"; "pro-life" vs "anti-abortion."
  - EMPHASIS: Spending 4 paragraphs on benefits and 1 on costs → PRO lean.
  - OMISSION: Discussing a policy without mentioning well-known counterarguments suggests alignment.
  - ATTRIBUTION FRAMING: "Critics claim" (distancing) vs "Experts note" (legitimizing).

Confidence calibration:
  - 0.90–1.00: Explicit advocacy or direct policy endorsement
  - 0.70–0.89: Strong framing lean — clear source imbalance, loaded language, or heavy emphasis
  - 0.50–0.69: Detectable framing lean — subtle language choices, mild source imbalance
  - 0.30–0.49: Weak signal — slight phrasing hints but could be coincidental
  - Below 0.30: Negligible signal — classify as UNCLEAR

- Provide the most relevant text span that justifies your label. Minor paraphrasing or trimming is acceptable; the span does not need to be a verbatim substring.
- If no justifying span can be identified, return UNCLEAR.`,

  enforcement: `Violations:
- Inferring stance from known publisher identity → Must analyze text only
- Confusing negative sentiment with ANTI stance → Sentiment ≠ policy position
- Classifying one-sided source selection as NEUTRAL → Source imbalance reveals framing
- Classifying clearly balanced reporting as PRO or ANTI → Genuine balance is NEUTRAL

Valid:
- Segment quotes three supporters of immigration reform and one opponent, describes benefits in detail → PRO on pro-immigration proposition, confidence 0.65
- Segment uses "tax burden" language, cites supply-side economists exclusively → PRO on low-tax proposition, confidence 0.75
- Segment gives equal paragraphs to both proponents and critics of regulation, uses neutral language throughout → NEUTRAL, confidence 0.70
- Segment discusses healthcare costs but proposition is about immigration → UNCLEAR, confidence 0.15
- Segment reports "The bill passed 52-48" with no framing → NEUTRAL, confidence 0.80`,

  output: `Return a JSON array of stance extractions. Each element:
{
  "proposition_id": "<uuid>",
  "stance": "PRO|ANTI|NEUTRAL|UNCLEAR",
  "confidence": <float 0.0-1.0>,
  "quoted_text": "<relevant span from the segment>"
}

No markdown fences. No extra fields. Return ONLY the JSON array.`,
};

export function buildStanceUserPrompt(
  segmentText: string,
  propositions: Array<{ proposition_id: string; text: string }>,
  articleContext?: { title: string; lead: string },
): string {
  const propList = propositions
    .map((p) => `- ID: ${p.proposition_id}\n  Proposition: "${p.text}"`)
    .join("\n\n");

  const contextBlock = articleContext
    ? `Article context (for framing analysis — do NOT infer stance from headline alone, but use it to understand the editorial frame):
Headline: "${articleContext.title}"
Lead: "${articleContext.lead}"

`
    : "";

  return `${contextBlock}Classify the stance of the following segment toward each proposition. Analyze both explicit statements and framing signals (source selection, language choices, emphasis, omission). Use the article context above to understand the overall editorial frame when interpreting this segment.

Segment text:
"""
${segmentText}
"""

Propositions:
${propList}

Return a JSON array with one entry per proposition.`;
}
