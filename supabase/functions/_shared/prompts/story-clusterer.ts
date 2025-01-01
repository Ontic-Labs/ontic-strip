import type { CfpoTemplate } from "../prompt-types.ts";

export const storyClustererTemplate: CfpoTemplate = {
  name: "Story Cluster Labeler",
  version: 1,

  voice: `You are a news analyst. You generate concise headlines and summaries for clusters of related articles.`,

  mission: `Given clusters of article titles grouped by topic similarity, generate a short headline title and a one-sentence summary for each cluster. The title captures the shared story; the summary explains the common thread.`,

  rules: `- Titles must be max 10 words
- Summaries must be one sentence
- Use neutral, factual language
- The title should describe the story, not the cluster (e.g. "Hurricane Milton Approaches Florida", not "Articles About Hurricane Milton")
- If articles in a cluster cover different angles of the same story, the title should capture the overarching topic`,

  enforcement: `Violations:
- Title: "Collection of Articles About Economic Policy" -> Describes the cluster, not the story. Should be: "Federal Reserve Holds Rates Amid Inflation Concerns"
- Title exceeding 10 words -> Must be concise headline-style

Valid:
- Title: "Ukraine Counteroffensive Gains Ground in East" / Summary: "Multiple outlets report on territorial advances by Ukrainian forces in the Donetsk region." -> Factual, concise, describes the story
- Title: "Tech Layoffs Accelerate in Q1 2025" / Summary: "Several major technology companies announced workforce reductions in the first quarter." -> Neutral headline with one-sentence summary`,

  output: `Use the provided tool to return structured cluster labels. Each cluster entry must have: index (1-based), title (max 10 words), summary (one sentence).`,
};

// ---- Tool Definition ----

export const clusterLabelTool = {
  type: "function" as const,
  function: {
    name: "label_clusters",
    description: "Label each cluster with a title and summary",
    parameters: {
      type: "object",
      properties: {
        clusters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number" },
              title: { type: "string", description: "Short headline, max 10 words" },
              summary: { type: "string", description: "One sentence summary" },
            },
            required: ["index", "title", "summary"],
            additionalProperties: false,
          },
        },
      },
      required: ["clusters"],
      additionalProperties: false,
    },
  },
};

export const clusterLabelToolChoice = {
  type: "function" as const,
  function: { name: "label_clusters" },
};

// ---- User Prompt Builder ----

export interface ClusterInput {
  clusterIndex: number;
  titles: string[];
}

export function buildClusterLabelUserPrompt(clusters: ClusterInput[]): string {
  const body = clusters
    .map((c) => `Cluster ${c.clusterIndex} (${c.titles.length} articles):\n- ${c.titles.join("\n- ")}`)
    .join("\n\n");

  return `Generate titles and summaries for these article clusters:\n\n${body}`;
}
