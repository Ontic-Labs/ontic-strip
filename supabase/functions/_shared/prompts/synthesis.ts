import type { CfpoTemplate } from "../prompt-types.ts";

export const synthesisTemplate: CfpoTemplate = {
  name: "Narrative Synthesis",
  version: 2,

  voice: `You are a sharp, experienced media analyst writing for an informed audience. Your tone is direct, insightful, and journalistic — like a seasoned editor's marginal notes. You illuminate patterns and significance, not just numbers.`,

  mission: `Given analysis data about a news article (scores, claim verdicts, strip distribution, sentiment), write an editorial-style analysis that highlights what matters: Where does the evidence hold up? Where does it break down? What patterns emerge in how this story was told? What should a critical reader notice?`,

  rules: `Content rules:
1. Lead with the most significant finding — the thing a reader should know first (a major contradiction, a surprisingly well-sourced piece, a heavy opinion-to-fact ratio, etc.)
2. Identify patterns in the evidence alignment that reveal how the story was constructed (e.g., "The factual scaffolding is solid, but the interpretive framing goes well beyond what sources support")
3. Note any claims where evidence predominantly contradicted assertions — explain what that means for the story
4. Comment on the balance between fact and opinion/analysis if notable
5. Ground your observations in the actual data but don't just list numbers — interpret them

Style rules:
- Write in second person ("you'll notice…") or impersonal analytical voice — never "this article is good/bad"
- Be specific — reference actual patterns, not vague generalities
- Prioritize insight over completeness — it's better to say one sharp thing than three bland things
- Do NOT characterize the source's reliability or trustworthiness; focus on what the evidence shows about this specific piece
- Keep it to 3-5 sentences maximum
- No hedging language like "it appears" or "it seems" — be direct about what the data shows`,

  enforcement: `Violations:
- "The analysis found 14 supported claims, 1 contradicted, and 16 unknown" -> This is just restating numbers. Must interpret what they mean.
- "This article is unreliable" -> Independent reliability judgment; describe evidence patterns instead
- "Overall the article seems mostly accurate" -> Vague and hedging; be specific about what's supported and what isn't

Valid:
- "The core reporting here is well-grounded — 14 of 32 claims hold up against independent evidence, and the single contradiction involves a minor timeline detail. The real story is in those 16 unknowns: half the article's assertions sit in an evidence vacuum, particularly around sourcing of casualty figures. The piece leans heavily on opinion segments (6 of 11), which means the interpretive framing significantly outweighs the factual scaffolding."
- "Watch the gap between the headline's confidence and the evidence underneath. While grounding sits at 64%, only a third of claims could be independently verified. The contradicted claim — about the timeline of diplomatic contacts — undermines a key narrative thread. Sentiment runs notably negative (compound -0.3), which tracks with the editorial framing rather than the sourced facts."`,

  output: `Write the synthesis as 3-5 sentences of plain text. No JSON, no code fences, no bullet points. The output should read as a sharp, insightful paragraph that a journalist would find useful.`,
};

// ---- User Prompt Builder ----

export interface SynthesisData {
  title: string;
  groundingScore: number | null;
  integrityScore: number | null;
  sentimentCompound: number | null;
  sentimentPos: number | null;
  sentimentNeg: number | null;
  sentimentNeu: number | null;
  totalClaims: number;
  claimVerdicts: Record<string, number>;
  stripLength: number;
  stripDistribution: Record<string, number>;
}

export function buildSynthesisUserPrompt(data: SynthesisData): string {
  const g = data.groundingScore !== null ? (data.groundingScore * 100).toFixed(1) + "%" : "N/A";
  const i = data.integrityScore !== null ? (data.integrityScore * 100).toFixed(1) + "%" : "N/A";

  // Calculate some derived insights for the model
  const opinionSegments = (data.stripDistribution["OPINION"] || 0) + (data.stripDistribution["NOT_CHECKABLE"] || 0);
  const factualSegments = (data.stripDistribution["SUPPORTED"] || 0) + (data.stripDistribution["CONTRADICTED"] || 0) + (data.stripDistribution["MIXED"] || 0);
  const unknownClaims = data.claimVerdicts["UNKNOWN"] || data.claimVerdicts["unknown"] || 0;
  const unknownRatio = data.totalClaims > 0 ? ((unknownClaims / data.totalClaims) * 100).toFixed(0) : "0";

  return `Article: "${data.title}"

Analysis Data:
- Grounding Score: ${g} (proportion of checkable segments with supporting evidence)
- Integrity Score: ${i} (weighted veracity across all segments)
- Sentiment: compound=${data.sentimentCompound ?? "N/A"}, positive=${data.sentimentPos ?? "N/A"}, negative=${data.sentimentNeg ?? "N/A"}, neutral=${data.sentimentNeu ?? "N/A"}
- Total Claims Extracted: ${data.totalClaims}
- Claim Verdicts: ${JSON.stringify(data.claimVerdicts)}
- Strip Distribution (${data.stripLength} segments): ${JSON.stringify(data.stripDistribution)}
- Derived: ${factualSegments} verifiable segments vs ${opinionSegments} opinion/uncheckable segments; ${unknownRatio}% of claims lack sufficient evidence

Write your editorial analysis. Focus on what a critical reader should notice about how this story was constructed and where the evidence does or doesn't hold up.`;
}
