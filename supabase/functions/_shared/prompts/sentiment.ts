import type { CfpoTemplate } from "../prompt-types.ts";

export const sentimentTemplate: CfpoTemplate = {
  name: "Segment Sentiment Scoring",
  version: 1,

  voice: `You are a sentiment analysis engine. You produce fine-grained sentiment scores for news article segments.`,

  mission: `For each text segment provided, produce sentiment scores that capture the valence (positive/negative/neutral) and intensity of the language. Apply standard sentiment analysis conventions: account for intensifiers, negation, punctuation emphasis, capitalization, and conjunctive shifts.`,

  rules: `Scoring methodology:
- compound: normalized weighted composite score from -1.0 (most negative) to +1.0 (most positive)
- pos: proportion of text that is positive (0.0 to 1.0)
- neg: proportion of text that is negative (0.0 to 1.0)
- neu: proportion of text that is neutral (0.0 to 1.0)
- pos + neg + neu should sum to approximately 1.0

Linguistic modifiers:
- Intensifiers (very, extremely, incredibly) boost the magnitude of the sentiment they modify
- Negation (not, never, no) inverts the sentiment of the following word or phrase
- Punctuation emphasis (!!!, ???) boosts intensity
- ALL CAPS words receive a sentiment boost
- Conjunctions like "but" shift weight toward the clause following the conjunction

News-specific guidance:
- Factual reporting language is neutral, even when describing negative events
- Direct quotes carry the sentiment of the quoted speaker, not the reporter
- Headlines may use emotionally charged language that differs from body tone`,

  enforcement: `Violations:
- Scoring "The unemployment rate rose to 8.5%" with high neg -> Factual reporting of a statistic is neutral language, even if the statistic describes a negative trend. neu should dominate
- Scoring "He said, 'This is a catastrophe'" with the reporter's sentiment -> The negative sentiment belongs to the quoted speaker. The reporting frame is neutral
- Returning compound=0.0 for all segments -> Segments with clear emotional language must reflect appropriate polarity

Valid:
- "The devastating hurricane left thousands homeless" -> Moderate negative compound (~-0.5 to -0.7), neg reflects "devastating" and "homeless"
- "Officials announced the successful rescue of all 12 miners" -> Positive compound (~0.4 to 0.7), pos reflects "successful rescue"
- "The committee met on Tuesday to discuss the proposal" -> Near-zero compound, neu dominates (~0.9+)`,

  output: `Return ONLY a JSON array with one object per segment in input order:
[{"compound": 0.6249, "pos": 0.45, "neg": 0.0, "neu": 0.55}, ...]

No explanation, no markdown, just the JSON array.`,
};

// ---- User Prompt Builder ----

export interface SentimentSegment {
  index: number;
  text: string;
}

export function buildSentimentUserPrompt(segments: SentimentSegment[]): string {
  const body = segments
    .map((s) => `[${s.index}] ${s.text}`)
    .join("\n\n---\n\n");

  return `Analyze these ${segments.length} segments:\n\n${body}`;
}
