# AI Workflow — Ontic Strip Pipeline

> Shared infrastructure and end-to-end AI orchestration for the Ontic Strip
> analysis pipeline. All edge functions live in `supabase/functions/` and share
> the modules documented below.

---

## Table of Contents

1. [Pipeline Overview](#1-pipeline-overview)
2. [Shared Modules](#2-shared-modules)
3. [CFPO Prompt Framework](#3-cfpo-prompt-framework)
4. [LLM Gateway & Model Map](#4-llm-gateway--model-map)
5. [Stage-by-Stage Walkthrough](#5-stage-by-stage-walkthrough)
6. [Scoring Engine](#6-scoring-engine)
7. [Ideology IRT Estimator](#7-ideology-irt-estimator)
8. [Entity & Event Resolution](#8-entity--event-resolution)
9. [Orchestration & Retry](#9-orchestration--retry)
10. [Data Flow Diagram](#10-data-flow-diagram)

---

## 1. Pipeline Overview

Every news article passes through a **10-stage sequential pipeline** followed
by **5 parallel post-processing stages**. The orchestrator (`pipeline-worker`)
reads jobs from a **pgmq** queue and dispatches each stage as an HTTP call to
the corresponding Supabase Edge Function.

```
 ┌─────────────────────┐
 │  collector / rss     │  Ingest from Inoreader or direct RSS/Atom
 └─────────┬───────────┘
           ▼
 ┌─────────────────────┐
 │  normalizer          │  Firecrawl scrape → LLM content cleaning
 └─────────┬───────────┘
           ▼
 ┌─────────────────────┐
 │  indexer             │  Paragraph/sentence chunking → embeddings
 └─────────┬───────────┘
           ▼
 ┌─────────────────────┐
 │  oracle-classifier   │  Segment classification + rhetorical flags
 └─────────┬───────────┘
           ▼
 ┌─────────────────────┐
 │  oracle-extractor    │  Atomic claim extraction with SIRE metadata
 └─────────┬───────────┘
           ▼
 ┌─────────────────────┐
 │  oracle-evidence     │  Corpus vector search for claim evidence
 └─────────┬───────────┘
           ▼
 ┌─────────────────────┐
 │  oracle-veracity     │  NLI scoring + web verification
 └─────────┬───────────┘
           ▼
      pipeline_status = "aggregated"
           │
     ┌─────┼──────┬──────────┬──────────┐
     ▼     ▼      ▼          ▼          ▼
  aggreg  sent  synth     ideology   event-enricher
  ator    iment  esis
```

**Independent cron job:** `story-clusterer` (groups articles into stories).
**Utilities:** `firecrawl-scrape` (proxy), `seed-propositions` (one-time setup).

---

## 2. Shared Modules

All files in `_shared/` are imported by edge functions via relative paths.

| Module | Purpose |
|---|---|
| `prompt-types.ts` | TypeScript interfaces: `CfpoTemplate`, `PromptConfig`, `LlmRequest/Response` |
| `prompt-registry.ts` | Versioned manifest of all 12 prompt configs (model, temperature, gateway, tokens) |
| `prompt-builder.ts` | CFPO v2 compiler: assembles template sections, resolves `{{VARIABLES}}` |
| `llm-client.ts` | Unified OpenAI-compatible chat completion client (OpenRouter gateway) |
| `scoring-constants.ts` | Every magic number in the scoring pipeline — single-file audit surface |
| `scoring-math.ts` | Grounding, integrity, sourcing, editorialization, factuality, claim-grounding formulas |
| `ideology-constants.ts` | RAG retrieval, stance extraction, and MAP IRT parameters |
| `ideology-irt.ts` | Rasch / 1PL MAP estimator via Newton-Raphson |
| `entity-normalization.ts` | Entity alias mapping, geo canonicalization, Jaccard similarity, time-bucketing |
| `prompts/` | 12 CFPO template files (one per AI stage) |

---

## 3. CFPO Prompt Framework

All LLM prompts use the **CFPO v2** (Voice → Mission → Rules → Enforcement → Output)
template structure, defined in `prompt-types.ts`:

```typescript
interface CfpoTemplate {
  name: string;
  version: number;
  voice?: string;      // Persona / tone calibration
  mission: string;     // What this prompt accomplishes
  rules: string;       // Constraints, taxonomies, enums
  enforcement: string; // Paired violation / valid examples
  output: string;      // Output format spec (JSON schema)
  variables?: string[];
}
```

**Compilation flow:**
1. `compilePrompt(key, template, variables)` looks up `PromptConfig` from the
   registry.
2. `assembleSections()` joins sections with `---` dividers and `## Header`
   markers in mandatory order.
3. `resolveVariables()` substitutes `{{VAR}}` placeholders. Undefined vars are
   left in place (no silent swallowing — CFPO invariant).
4. Returns `{ systemPrompt, config }` — the edge function passes both to
   `callLlm()`.

**Variable resolution rules:**
- Arrays → joined with `\n`
- Booleans/numbers → stringified
- `undefined` → placeholder left as-is (fail-loud)

---

## 4. LLM Gateway & Model Map

`llm-client.ts` routes all models through OpenRouter (OpenAI-compatible):

| Gateway | URL | Key Env Var |
|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` |

**Model assignment** (from `prompt-registry.ts`):

| Prompt Key | Model | Gateway | Temp | Max Tokens |
|---|---|---|---|---|
| `normalizer` | `google/gemini-2.5-flash-lite` | openrouter | 0.0 | 8192 |
| `classifier` | `perplexity/sonar` | openrouter | 0.1 | 4000 |
| `extractor` | `perplexity/sonar` | openrouter | 0.1 | 16000 |
| `veracity-nli` | `perplexity/sonar` | openrouter | 0.1 | 8000 |
| `veracity-web` | `perplexity/sonar` | openrouter | 0.1 | 8000 |
| `sentiment` | `google/gemini-2.5-flash-lite` | openrouter | 0.0 | 4000 |
| `synthesis` | `perplexity/sonar` | openrouter | 0.3 | 500 |
| `ideology` | `google/gemini-2.5-flash` | openrouter | 0.1 | 1000 |
| `stance` | `google/gemini-2.5-flash` | openrouter | 0.1 | 2000 |
| `story-clusterer` | `google/gemini-2.5-flash-lite` | openrouter | 0.0 | 4000 |
| `event-classifier` | `google/gemini-2.5-flash-lite` | openrouter | 0.0 | 256 |
| `feed-description` | `google/gemini-2.5-flash-lite` | openrouter | 0.0 | 256 |

**Response handling:**
- JSON responses are auto-stripped of markdown code fences.
- Perplexity citations are extracted from `data.citations` (direct) or
  `message.annotations` (OpenRouter URL_CITATION objects), deduplicated.
- Tool call arguments are extracted from the first `tool_calls[0].function.arguments`.

**Embedding model:** `openai/text-embedding-3-small` (via OpenRouter) — used by
`indexer`, `oracle-evidence`, `oracle-ideology`, and `seed-propositions`.

---

## 5. Stage-by-Stage Walkthrough

### 5.1 Collection

| Function | Trigger | LLM | DB Writes |
|---|---|---|---|
| `collector` | HTTP POST (cron) | — | `feeds`, `documents` |
| `rss-collector` | HTTP POST | — | `feeds`, `documents` |

**collector** pulls up to 50 unread items from Inoreader, refreshing OAuth
tokens as needed. Deduplicates by URL, inserts with RSS summary as
`raw_content`, sets `pipeline_status: "normalizing"`, and enqueues
`{stage: "NORMALIZE"}` into pgmq.

**rss-collector** directly fetches and parses RSS/Atom XML via regex. Supports
single-feed or bulk polling (filters by `polling_interval_minutes`). Processes
max 10 feeds per cycle.

### 5.2 Normalization

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `normalizer` | `normalizer` template | gemini-2.5-flash-lite | `documents.raw_content` → `documents.normalized_content` |

1. Calls `firecrawl-scrape` to get full-page markdown (truncated to 30k chars).
2. LLM strips boilerplate, ads, navigation, images, and subscription prompts.
3. Output: clean article prose as markdown (`# Headline\nBy Author, Date\n\n...`).
4. Supports `{{PUBLISHER_EXCLUSIONS}}` variable for per-publisher ad patterns.
5. If either Firecrawl or LLM yields insufficient content, marks `fetch_status: "failed"`.

### 5.3 Indexing

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `indexer` | — | text-embedding-3-small | `documents.normalized_content` → `segments` |

1. Splits normalized prose into paragraph→sentence chunks (~80–200 tokens).
2. Prepends corpus front-matter context (publisher name, tier, date) to
   embedding inputs.
3. Generates embeddings via OpenRouter embeddings API.
4. Stores segments with `embedding`, `text_content`, `token_count`.
5. Supports re-indexing by deleting old segments first.

### 5.4 Classification

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `oracle-classifier` | `classifier` template | perplexity/sonar | `segments` → `segments.classification` |

Classifies each segment into one of four categories:

| Label | Description |
|---|---|
| `FACTUAL_CLAIM` | Checkable empirical assertions |
| `OPINION_ANALYSIS` | Subjective interpretation, editorial judgment |
| `PROCEDURAL` | Process/timeline descriptions |
| `OTHER` | Boilerplate, structural elements |

**Rhetorical flags** (per segment):
- `is_sarcastic` → overrides to `OPINION_ANALYSIS`
- `is_hypothetical` → flags conditional content
- `is_rhetorical_question` → overrides to `OPINION_ANALYSIS`
- `is_quotation` → marks attributed content

Batches 10 segments per LLM call. Sets preliminary `label` (OPINION→`"OPINION"`,
PROCEDURAL→`"NEUTRAL"`, FACTUAL_CLAIM→`null` pending veracity).

### 5.5 Claim Extraction

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `oracle-extractor` | `extractor` template | perplexity/sonar | `segments` (FACTUAL_CLAIM) → `claims` |

Extracts **atomic, self-contained, checkable claims** from factual segments.
Each claim includes **SIRE metadata**:

| SIRE Component | Contents |
|---|---|
| **S**cope | Named entities, topics, temporal scope |
| **I**nformation | Time qualifier, geography, conditions, quantifiers |
| **R**etrieval | 2–3 search queries, preferred evidence tiers, time window, claim type |
| **E**xclusions | `is_checkable` boolean, exclusion reasons |

**Attribution splitting:** When a segment says "X said Y", two claims are
produced: (1) an `ATTRIBUTION` claim ("X stated Y") and (2) a `CONTENT` claim
(the factual assertion Y, independently checkable).

**Risk classification:** Regex-based detection assigns `CRITICAL`, `HIGH`,
`MEDIUM`, or `LOW` to claims involving geopolitical events.

### 5.6 Evidence Retrieval

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `oracle-evidence` | — | text-embedding-3-small | `claims` → `evidence` |

1. Embeds claim text via OpenRouter embeddings API.
2. Calls `match_segments` pgvector RPC for cosine-similar segments (excluding
   same-document evidence).
3. Assigns evidence **tier** by source domain:

   | Tier | Domain Examples | Weight |
   |---|---|---|
   | T1 | whitehouse.gov, sec.gov, who.int | 1.00 |
   | T2 | reuters.com, apnews.com | 0.85 |
   | T3 | wikipedia.org, snopes.com | 0.70 |
   | T4 | Established news outlets | 0.45 |
   | T5 | Internal corpus | 0.20 |

4. Deduplicates by canonical snippet+URL.
5. Filters near-duplicates (Jaccard > 0.92) and same-publisher evidence.
6. Max `MAX_EVIDENCE_PER_CLAIM` (5) per claim with
   `EVIDENCE_FETCH_HEADROOM` (3) extra for filtering.

### 5.7 Veracity Scoring

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `oracle-veracity` | `veracity-nli`, `veracity-web` | perplexity/sonar | `evidence` → `claims.veracity_label`, `segments.label` |

**Two verification paths:**

1. **Corpus NLI** — For claims with corpus evidence: LLM scores each
   claim-evidence pair as `ENTAILMENT`, `CONTRADICTION`, or `NEUTRAL` with
   calibrated confidence.

2. **Web Verification** — For claims without corpus evidence: Sonar web search
   retrieves external sources and synthesizes a verdict with URL citations.

**Scope-match gate** (prevents out-of-scope evidence from flipping verdicts):
- Jaccard overlap ≥ `SCOPE_JACCARD_MIN` (0.12)
- Embedding similarity ≥ `SCOPE_EMBEDDING_SIM_MIN` (0.55)
- Tighter thresholds for legal (0.18) and geopolitical (0.15) claims
- Failed scope check → demote to `NEUTRAL` with capped confidence

**Risk gating:**
- `CRITICAL` claims require T1/T2 evidence (rank ≤ 2); otherwise capped at 0.30 confidence
- `HIGH` claims require T1/T2/T3 evidence (rank ≤ 3); otherwise capped at 0.40 confidence
- Low-tier (T4/T5) support capped at 0.60 confidence

**Weighted segment label voting:** Aggregates per-claim verdicts into segment
labels using configurable weights (SUPPORTED=1.0, CONTRADICTED=1.2, MIXED=0.1).
Attribution claims are protected from `CONTRADICTED` label.

### 5.8 Aggregation (Scoring)

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `aggregator` | — | — | `segments` + `claims` + `evidence` → `documents` scores |

Computes all composite scores and the visual strip. See [§6 Scoring Engine](#6-scoring-engine)
for formula details.

Also updates **publisher baselines** (7-day and 30-day rolling averages) across
all metrics including ideology.

### 5.9 Sentiment Analysis

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `oracle-sentiment` | `sentiment` template | gemini-2.5-flash-lite | `segments` → `segments.sentiment_*`, `documents.sentiment_*` |

Produces VADER-style scores per segment:
- `compound`: normalized composite −1.0 to +1.0
- `pos` / `neg` / `neu`: proportions summing to ~1.0

Linguistic modifiers: intensifiers, negation, punctuation emphasis, ALL CAPS,
conjunctive "but" shifts. News-specific: factual language is neutral even when
describing negative events; quotes carry the speaker's sentiment.

Batches 10 segments per LLM call. Averages segment scores to document level.

### 5.10 Synthesis

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `oracle-synthesis` | `synthesis` template | perplexity/sonar | scores + claims → `documents.synthesis_text` |

Generates **3–5 sentences** of editorial-style prose analysis. Highlights:
- Most significant finding (major contradiction, good sourcing, opinion-heavy ratio)
- Evidence alignment patterns
- Contradicted claims and their narrative impact
- Fact-to-opinion balance

Tone: direct, insightful, journalistic. Second person or impersonal analytical
voice. No hedging.

### 5.11 Ideology Scoring

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `oracle-ideology` | `stance` template | gemini-2.5-flash | `segments` + `proposition_bank` → `ideology_scores` |

See [§7 Ideology IRT Estimator](#7-ideology-irt-estimator).

### 5.12 Event Enrichment

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `event-enricher` | `event-classifier` template | gemini-2.5-flash-lite | `claims` (SIRE) → `documents.event_key`, `events` |

See [§8 Entity & Event Resolution](#8-entity--event-resolution).

### 5.13 Story Clustering (Independent)

| Function | Prompt | Model | I/O |
|---|---|---|---|
| `story-clusterer` | `story-clusterer` template + tool calling | gemini-2.5-flash-lite | `documents` → `story_clusters` |

1. Averages first 3 segment embeddings per document.
2. Builds pairwise cosine similarity matrix (threshold = 0.60).
3. Greedy density-based clustering: seeds from highest-degree nodes, requires
   35% pairwise density. Min cluster size 2, max 15.
4. LLM generates headline (≤ 10 words) and one-sentence summary per cluster
   via **function calling** (`label_clusters` tool).
5. Full re-cluster each run (deletes old clusters, 72-hour window).

---

## 6. Scoring Engine

All formulas live in `scoring-math.ts`. Every constant is centralized in
`scoring-constants.ts` for single-file auditability.

### 6.1 Grounding Score

Proportion of checkable segments that received a directional verdict:

$$\text{Grounding} = \frac{S + C + M}{\text{checkableTotal}}$$

where $S$ = SUPPORTED, $C$ = CONTRADICTED, $M$ = MIXED, and checkableTotal
excludes `OTHER`, `OPINION`, `NOT_CHECKABLE`, and `NEUTRAL` labels.

Returns 0 if `checkableTotal ≤ 0`.

### 6.2 Integrity Score

Weighted veracity across all checkable segments, normalized to [0, 1]:

$$\text{raw} = \frac{S \cdot w_S - C \cdot w_C + M \cdot w_M}{\max(\text{checkable}, 3)}$$

$$\text{Integrity} = \operatorname{clamp}\!\left(\frac{\text{raw} + w_C}{w_S + w_C},\ 0,\ 1\right)$$

| Weight | Value |
|---|---|
| $w_S$ (SUPPORTED) | 1.0 |
| $w_C$ (CONTRADICTED) | 1.2 |
| $w_M$ (MIXED) | 0.25 |

`checkable = S + C + M + Unknown`. Denominator floored at 3 to prevent
small-sample score explosion.

**Low-sample flag:** `integrity_status = "low_sample"` when `checkable < 3`.

### 6.3 Sourcing Quality

Weighted average of evidence tier quality:

$$\text{Sourcing} = \frac{\sum_t w_t \cdot n_t}{\sum_t n_t}$$

Penalized when total evidence < `SOURCING_MIN_EVIDENCE` (3):

$$\text{Sourcing}_{\text{final}} = \text{Sourcing} \cdot \min\!\left(1,\ \frac{n_{\text{total}}}{3}\right)$$

### 6.4 Editorialization (One-Sidedness)

$$\text{Edit} = 0.40 \cdot \text{opinionRatio} + 0.35 \cdot |\text{sentimentCompound}| + 0.25 \cdot |\text{opinionRatio} - \text{factualRatio}|$$

Uses total segments (including non-checkable) as denominator for ratios so
overall article tone is captured.

### 6.5 Factuality Composite

MBFC-inspired weighted blend:

$$\text{Factuality} = 0.40 \cdot (1 - \text{contradictionRate}) + 0.25 \cdot \text{sourcing} + 0.25 \cdot \text{grounding} + 0.10 \cdot (1 - \text{editorialization})$$

where $\text{contradictionRate} = C / V$, $V = S + C + M$.

**Low-sample flag:** `factuality_status = "low_sample"` when $V < 3$.

### 6.6 Claim-Level Grounding

$$\text{ClaimGrounding} = \frac{\text{supportedClaims} + \text{contradictedClaims} + \text{mixedClaims}}{\text{totalClaims}}$$

---

## 7. Ideology IRT Estimator

Implemented in `ideology-irt.ts` + `ideology-constants.ts`.

### 7.1 Proposition Bank

50 canonical political propositions across 10 domains, seeded via
`seed-propositions`. Each proposition has:
- `text`: the policy statement
- `liberal_is_pro`: polarity mapping (true = PRO aligns liberal)
- `difficulty_b`: IRT difficulty parameter
- `domain`: one of immigration, fiscal, regulation, social, criminal_justice,
  foreign_policy, labor, environment, executive_power, corporate_governance
- `embedding`: text-embedding-3-small vector

### 7.2 RAG Retrieval (oracle-ideology)

1. Cosine similarity between segment embeddings and proposition embeddings.
2. Filtering: `PROP_SIM_THRESHOLD` (0.40) with keyword overlap, or
   `PROP_SIM_THRESHOLD_NO_KEYWORDS` (0.42) without.
3. Cross-domain penalty: −0.05; keyword boost: +0.02.
4. Top 5 propositions per segment after filtering.
5. Top 8 segments sent to LLM for stance extraction.

### 7.3 Stance Extraction

LLM classifies each segment-proposition pair as:
- `PRO` / `ANTI` / `NEUTRAL` / `UNCLEAR`
- With confidence (0.0–1.0) and verbatim quoted text justification.
- Confidence thresholds: accept ≥ 0.70, low_confidence ≥ 0.50, below 0.30 → UNCLEAR.

### 7.4 MAP Estimation (Rasch / 1PL)

Binary encoding per polarity contract:
$$y_i = \begin{cases} 1 & \text{if liberal-aligned stance} \\ 0 & \text{otherwise} \end{cases}$$

Rasch probability:
$$P(y_i = 1 \mid \theta) = \frac{1}{1 + e^{-(\theta - b_i)}}$$

**MAP objective** with Gaussian prior $\mathcal{N}(0, \sigma^2)$, $\sigma^2 = 1.0$:

Newton-Raphson iteration (max 10, tolerance 0.001):
$$\theta_{t+1} = \theta_t - \frac{g}{H}$$

where:
$$g = \sum_i (y_i - p_i) - \frac{\theta}{\sigma^2}, \quad H = -\sum_i p_i(1-p_i) - \frac{1}{\sigma^2}$$

Hessian floored at −0.01 for numerical stability. Step-size capped at ±2.0.

**Output normalization:** $\text{score} = \tanh(\theta / 2) \in [-1, +1]$

**Standard error:** $\text{SE} = \sqrt{-1/H}$

**Minimum signal:** Requires ≥ 3 valid stances (PRO/ANTI with confidence ≥ 0.50).

**Domain cap:** No single domain may contribute more than 40% of votes.

**2D split:** Economic vs. social dimension votes are scored separately
for the 2-axis ideology breakdown.

---

## 8. Entity & Event Resolution

Implemented in `entity-normalization.ts` + `event-enricher`.

### 8.1 Entity Normalization

- 80+ entity aliases (countries, leaders, institutions) mapped to canonical forms.
- Lowercase, strip punctuation, collapse whitespace, then alias lookup.
- Deduplication by frequency → top N (default 5).

### 8.2 Geo Canonicalization

- 60+ geo entries mapped to ISO-inspired codes (e.g., `"gaza"` → `"PS-GZA"`).
- Exact match → prefix match on comma/slash-separated parts → fallback to cleaned text.

### 8.3 EventKey Generation

Deterministic SHA-256 hash:
```
SHA256( eventType | geoPrimary | timeBucket | sortedEntities )
```
- `timeBucket`: UTC timestamp floored to nearest 6-hour window.
- `sortedEntities`: normalized, deduplicated, alphabetically sorted.

### 8.4 Event Matching (Two-Pass)

1. **Exact key match:** Look up existing event by EventKey.
2. **Semantic crosswalk:** Weighted score against `match_event_centroids` RPC:
   - 55% document embedding similarity
   - 30% entity Jaccard overlap
   - 10% geo match
   - 5% event type match
3. If matched, update event centroid (running average) and increment count.
4. If no match, create new event.

### 8.5 Event Type Taxonomy

20 canonical types classified by LLM: `MILITARY_ACTION`, `ARMED_CONFLICT`,
`TERRORIST_ATTACK`, `ELECTION`, `LEGISLATION`, `INDICTMENT`, `DIPLOMACY`,
`ECONOMIC_EVENT`, `NATURAL_DISASTER`, `PUBLIC_HEALTH`, `POLICY_CHANGE`,
`PROTEST`, `APPOINTMENT`, `INVESTIGATION`, `INFRASTRUCTURE`, `SCIENCE_TECH`,
`ENVIRONMENTAL`, `SOCIAL_CULTURAL`, `ANALYSIS`, `OTHER`.

---

## 9. Orchestration & Retry

`pipeline-worker` is the central dispatcher:

1. Pops up to **20 messages** from pgmq queue `pipeline_jobs`.
2. Deduplicates by `doc_id:stage` composite key.
3. Processes with **concurrency limit of 6**.
4. **Idempotency guard:** Checks `documents.pipeline_status` matches expected
   state before invoking each stage.
5. **Retry:** Exponential backoff, max 3 attempts per message.
6. **Dead-letter:** After 3 failures, moves to `pipeline_dlq` table.
7. **VERACITY re-enqueue:** If unscored claims remain after veracity, re-sends
   the job for another pass.

**Stage routing map:**

| pgmq Stage | Edge Function | Expected Status |
|---|---|---|
| `NORMALIZE` | `normalizer` | `normalizing` |
| `INDEX` | `indexer` | `pending` |
| `CLASSIFY` | `oracle-classifier` | `classifying` |
| `EXTRACT` | `oracle-extractor` | `extracting` |
| `EVIDENCE` | `oracle-evidence` | `verifying` |
| `VERACITY` | `oracle-veracity` | `verifying` |
| `AGGREGATE` | `aggregator` | `aggregated` |
| `SENTIMENT` | `oracle-sentiment` | `aggregated` |
| `SYNTHESIS` | `oracle-synthesis` | `aggregated` |
| `IDEOLOGY` | `oracle-ideology` | `aggregated` |
| `ENRICH` | `event-enricher` | `aggregated` |

---

## 10. Data Flow Diagram

```
                            ┌──────────────┐
                            │  Inoreader /  │
                            │  RSS Feeds    │
                            └──────┬───────┘
                                   │
                          ┌────────▼────────┐
                          │   collector /    │
                          │   rss-collector  │
                          │                 │
                          │ → documents     │
                          │ → feeds         │
                          └────────┬────────┘
                                   │ pgmq: NORMALIZE
                          ┌────────▼────────┐
                          │   normalizer    │
                          │                 │
                          │ Firecrawl →     │
                          │ gemini-flash-lite│
                          │                 │
                          │ → documents     │
                          │   .normalized   │
                          └────────┬────────┘
                                   │ pgmq: INDEX
                          ┌────────▼────────┐
                          │   indexer       │
                          │                 │
                          │ text-embed-3-sm │
                          │                 │
                          │ → segments      │
                          │   (+ embeddings)│
                          └────────┬────────┘
                                   │ pgmq: CLASSIFY
                          ┌────────▼────────┐
                          │  oracle-        │
                          │  classifier     │
                          │                 │
                          │ perplexity/sonar│
                          │                 │
                          │ → segments      │
                          │   .classification│
                          │   .label        │
                          └────────┬────────┘
                                   │ pgmq: EXTRACT
                          ┌────────▼────────┐
                          │  oracle-        │
                          │  extractor      │
                          │                 │
                          │ perplexity/sonar│
                          │                 │
                          │ → claims        │
                          │   (+ SIRE)      │
                          └────────┬────────┘
                                   │ pgmq: EVIDENCE
                          ┌────────▼────────┐
                          │  oracle-        │
                          │  evidence       │
                          │                 │
                          │ text-embed-3-sm │
                          │ + pgvector RPC  │
                          │                 │
                          │ → evidence      │
                          └────────┬────────┘
                                   │ pgmq: VERACITY
                          ┌────────▼────────┐
                          │  oracle-        │
                          │  veracity       │
                          │                 │
                          │ perplexity/sonar│
                          │ (NLI + web)     │
                          │                 │
                          │ → evidence.nli  │
                          │ → claims.verdict│
                          │ → segments.label│
                          └────────┬────────┘
                                   │
                    pipeline_status = "aggregated"
                                   │
              ┌──────────┬─────────┼─────────┬───────────┐
              ▼          ▼         ▼         ▼           ▼
        ┌──────────┐┌────────┐┌────────┐┌──────────┐┌──────────┐
        │aggregator││sentinel││synthes-││oracle-   ││event-    │
        │          ││ment    ││is      ││ideology  ││enricher  │
        │          ││        ││        ││          ││          │
        │scoring-  ││gemini- ││sonar   ││gemini-   ││gemini-   │
        │math.ts   ││flash-  ││        ││flash     ││flash-lite│
        │(no LLM)  ││lite    ││        ││+ IRT     ││+ SHA-256 │
        │          ││        ││        ││          ││          │
        │→ docs    ││→ segs  ││→ docs  ││→ stances ││→ docs    │
        │  .scores ││  .sent ││  .synth││→ ideology││  .event  │
        │→ pub     ││→ docs  ││        ││  _scores ││→ events  │
        │  baselin-││  .sent ││        ││          ││          │
        │  es      ││        ││        ││          ││          │
        └──────────┘└────────┘└────────┘└──────────┘└──────────┘

                          ┌─────────────────┐
                          │  story-clusterer │ (independent cron)
                          │                  │
                          │  gemini-flash-lite│
                          │  + tool calling  │
                          │                  │
                          │ → story_clusters │
                          │ → story_cluster  │
                          │   _members       │
                          └─────────────────┘
```

### Database Tables (Pipeline-Relevant)

| Table | Written By | Purpose |
|---|---|---|
| `feeds` | collector, rss-collector | Publisher feed metadata |
| `documents` | collector → synthesis | Article lifecycle, all scores |
| `segments` | indexer → sentiment | Chunked text, embeddings, labels, sentiment |
| `claims` | extractor → veracity | Extracted claims, SIRE, verdicts |
| `evidence` | evidence → veracity | Claim-evidence pairs with NLI labels |
| `proposition_bank` | seed-propositions | 50 canonical political propositions |
| `stance_extractions` | oracle-ideology | Per-segment stance votes |
| `ideology_scores` | oracle-ideology | Document-level ideology scores |
| `publisher_baselines` | aggregator | 7d/30d rolling metric averages |
| `story_clusters` | story-clusterer | Cluster metadata (title, summary) |
| `story_cluster_members` | story-clusterer | Document ↔ cluster membership |
| `events` | event-enricher | Canonical events with centroids |
| `pipeline_dlq` | pipeline-worker | Dead-lettered failed jobs |
