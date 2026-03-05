# Methodology

How Ontic Strip analyses news articles for evidence alignment, ideology, and factuality — from collection to synthesis. This page documents the full mathematical specification for transparency and reproducibility.

---

## Contents

1. [Pipeline Overview](#1-pipeline-overview)
2. [Scores Explained](#2-scores-explained)
3. [Ideology Scoring (IRT)](#3-ideology-scoring)
4. [Proposition Bank](#4-proposition-bank)
5. [RAG Retrieval](#5-rag-retrieval)
6. [Stance Extraction](#6-stance-extraction)
7. [MAP IRT Estimation](#7-map-irt-estimation)
8. [Ideology Aggregation](#8-ideology-aggregation)
9. [Factuality Scoring](#9-factuality-scoring)
10. [The Strip](#10-the-strip)
11. [Glossary](#glossary)
12. [Limitations](#limitations)

---

## 1. Pipeline Overview

Every article passes through a ten-stage pipeline. Each stage is handled by a dedicated edge function, orchestrated by Graphile Worker and stateless edge functions, with stage transitions managed by database triggers.

1. **Collection** — RSS feeds are polled at configurable intervals (default: every 5 minutes). New article URLs are recorded and their raw HTML is fetched via Firecrawl.

2. **Normalization** — Raw HTML is converted to clean markdown by Gemini flash-lite, stripping ads, navigation, and boilerplate while preserving article structure.

3. **Indexing** — Normalized text is split into segments (roughly paragraph-sized). Each segment is embedded using text-embedding-3-small (1536 dimensions) and stored for similarity search.

4. **Classification** — Sonar classifies each segment as FACTUAL_CLAIM, OPINION_ANALYSIS, PROCEDURAL, or OTHER. Only factual segments proceed to claim extraction.

5. **Extraction** — Sonar applies the SIRE framework (Scope · Information · Retrieval · Exclusions) to extract discrete, verifiable claims from factual segments.

6. **Evidence & Veracity** — For each claim, evidence is retrieved from the web and internal corpus. NLI analysis scores each passage as ENTAILMENT, CONTRADICTION, or NEUTRAL, producing veracity labels with confidence scores and tiered provenance (T1–T5).

7. **Sentiment** — Gemini flash-lite computes sentiment at the segment level (compound, positive, negative, neutral). Results are aggregated to document level. Sentiment is supplementary context and does not influence veracity.

8. **Aggregation** — Segment labels are assembled into the Strip. Grounding, Integrity, Sourcing Quality, Editorialization, and Factuality scores are computed from segment-level data using fixed weighting formulas. Factuality is a composite derived from grounding, contradiction rate, sourcing quality, and editorialization.

9. **Ideology** — Proposition-based IRT scoring: segments are matched to policy propositions via vector retrieval, stance is extracted per proposition, and a MAP (Maximum A Posteriori) θ estimate is computed via Newton-Raphson. See §3–8 below.

10. **Synthesis** — Sonar generates a summary restating claim-level results and evidence alignment. The synthesis does not assert independent judgments. Citation URLs are stored alongside the document.

---

## 2. Scores Explained

### Grounding Score (0–100)

The proportion of a document's segments with **directional evidence alignment** — supported, contradicted, or mixed. A high grounding score means most claims were testable and received a directional verdict from retrieved evidence.

$$
\text{Grounding} = \frac{S + C + M}{T}
$$

Where $S$ = Supported segments, $C$ = Contradicted (Disputed), $M$ = Mixed, $T$ = total segments excluding Not Checkable.

**Unknown** segments contain factual claims but insufficient retrieved evidence; they are excluded from the grounding numerator by design. **Neutral** segments have relevant evidence retrieved but NLI returned neutral (non-directional) alignment — they are also excluded from the numerator. **Not Checkable** segments (opinion, procedural) are excluded from both numerator and denominator.

Scores are computed on 0–1 internally and displayed as 0–100 by multiplying by 100. This convention applies to all scores in this section.

### Integrity Score (0–100)

A weighted score reflecting evidence alignment. Supported segments contribute positively (weight 1.0), contradicted segments incur a penalty (weight 1.2×), and mixed segments contribute lightly (weight 0.25×). The asymmetric weighting means contradictions have more impact — the system is deliberately conservative.

$$
\text{raw} = \frac{1.0 \cdot S - 1.2 \cdot C + 0.25 \cdot M}{\max(\text{checkable},\; 3)}
$$

$$
\text{integrity} = \text{clamp}\!\left(\frac{\text{raw} + 1.2}{2.2},\; 0,\; 1\right)
$$

Where checkable = $S + C + M + \text{Unknown}$. The min-denominator of 3 prevents small-sample score explosion. The normalization rescales the theoretical raw range $[-1.2,\;+1.0]$ into $[0, 1]$. When checkable < 3, the score is flagged as `low_sample` and displayed with an "⚠ low sample" badge rather than a definitive verdict.

### Sourcing Quality (0–100)

Rates the provenance quality of evidence. Each evidence piece is weighted by tier: T1 Primary Sources (1.0), T2 Wire Services (0.85), T3 Reference (0.70), T4 Established News (0.45), T5 Internal Corpus (0.20).

$$
\text{raw\_sourcing} = \frac{\sum(\text{tier\_weight} \times \text{count})}{\text{total\_evidence}}
$$

$$
\text{penalty} = \min\!\left(1,\; \frac{\text{total\_evidence}}{3}\right)
$$

$$
\text{sourcing\_final} = \text{raw\_sourcing} \times \text{penalty}
$$

Documents with fewer than 3 evidence pieces receive a proportional penalty to prevent inflated scores from a single high-tier source.

### Editorialization (0–100)

Measures rhetorical intensity via three signals: opinion density (40%), sentiment extremity (35%), and classification imbalance (25%). Higher scores indicate more editorialized presentation. This is *not* an ideology measure — it captures how much of the content is opinion vs. factual reporting, regardless of political direction.

$$
\text{editorialization} = 0.40 \cdot \text{opinion\_ratio} + 0.35 \cdot |\text{sentiment\_compound}| + 0.25 \cdot |p(\text{OPINION}) - p(\text{FACTUAL})|
$$

Where `opinion_ratio` = OPINION_ANALYSIS segments / total segments (including Not Checkable — this intentionally captures overall tone), `|sentiment_compound|` = absolute value of document-level sentiment, and `classification_imbalance = |p(OPINION) − p(FACTUAL_CLAIM)|` = absolute difference between OPINION_ANALYSIS and FACTUAL_CLAIM segment proportions. Classification imbalance captures skew between opinion and factual coverage beyond raw opinion density — the two terms are correlated but not identical, as opinion_ratio measures absolute density while imbalance measures relative dominance. All inputs are normalized to [0, 1].

### Sentiment Compound (−1 to +1)

A supplementary emotional-tone metric aggregated from per-segment analysis. Ranges from −1 (strongly negative) through 0 (neutral) to +1 (strongly positive). Does not directly factor into veracity.

---

## 3. Ideology Scoring

Ideology is measured using **proposition-based Item Response Theory (IRT)**, a psychometric framework that estimates a latent trait (political ideology) from observed responses to calibrated items. This replaces prompt-based classification with a mathematically grounded, reproducible estimator.

> **Polarity Convention**
>
> - $\theta > 0$ = more liberal. $\theta < 0$ = more conservative. $\theta = 0$ = centrist.
> - $y = 1$ = liberal-aligned stance on this proposition.
> - If `liberal_is_pro = true`: PRO → y=1, ANTI → y=0
> - If `liberal_is_pro = false`: PRO → y=0, ANTI → y=1
> - NEUTRAL / UNCLEAR → excluded from scoring.

The system operates in four stages: **Proposition Bank** (curated policy items) → **RAG Retrieval** (matching segments to relevant propositions) → **Stance Extraction** (LLM classification) → **MAP IRT Estimation** (Newton-Raphson θ computation).

**Key property:** Ideology score is *orthogonal* to veracity. A factually accurate article can lean left or right. A factually inaccurate article can lean left or right. The two measurements are independent by design.

---

## 4. Proposition Bank

The Proposition Bank contains 50 policy-principle-level statements spanning 10 domains. Each proposition is a declarative policy position (not tied to specific bills or politicians) with stable temporal relevance and clear falsifiability — meaning an article can take a clear PRO or ANTI stance on it.

| Domain | Count | Dimension | Liberal PRO / CON |
|---|---|---|---|
| Immigration | 5 | Social | 1 / 4 |
| Fiscal Policy | 5 | Economic | 3 / 2 |
| Regulation | 5 | Economic | 3 / 2 |
| Social Policy | 5 | Social | 3 / 2 |
| Criminal Justice | 5 | Social | 4 / 1 |
| Foreign Policy | 5 | Foreign | 3 / 2 |
| Labor | 5 | Economic | 4 / 1 |
| Environment | 5 | Economic | 3 / 2 |
| Executive Power | 5 | Executive | 2 / 3 |
| Corporate Governance | 5 | Economic | 5 / 0 |
| **Total** | **50** | **—** | **31 / 19** |

The 31/19 split reflects the actual policy landscape, not a labeling bias. The IRT model does not require polarity balance — a conservative article scores PRO on 19 propositions and ANTI on 31, providing ample signal in both directions.

**Per-proposition parameters (v1):**

- `discrimination_a = 1.0` for all items (Rasch/1PL model)
- `difficulty_b = 0.0` for all items (prior to calibration)
- Each proposition is tagged with `liberal_is_pro` (boolean), `domain`, `dimension`, and a keyword array for retrieval boosting
- Embeddings are generated via `text-embedding-3-small` (1536 dimensions)

---

## 5. RAG Retrieval

For each segment with an embedding, the system retrieves the most relevant propositions via cosine similarity search against the Proposition Bank. This determines which policy positions are relevant to the segment's content.

| Parameter | Value | Rationale |
|---|---|---|
| Initial K | 10 | Broad candidate pool |
| Final K (after filtering) | 6 | Bounded LLM input within edge budget |
| Similarity threshold (with keyword overlap) | ≥ 0.32 | Cosine similarity floor (recall-favoring; LLM stance extraction is the discriminator) |
| Similarity threshold (no keyword overlap) | ≥ 0.35 | Elevated floor compensates for missing lexical signal |
| Keyword boost | +0.03 | Soft boost, not hard gate — preserves recall |
| Cross-domain penalty | −0.05 | Reduces false matches across domains |
| Min segment tokens | 20 | Skip fragments too short for stance |
| Max segments scored per document | 8 | Deterministic selection: sorted by best_match_quality desc, then position_index asc. best_match_quality = max(adjusted_cosine_similarity) over retrieved propositions for that segment. Bounds LLM calls within 60s edge budget. |

**False-positive mitigation:**

1. **Domain filter:** Non-political segments (sports, entertainment, weather) skip retrieval entirely.
2. **Keyword overlap (soft boost):** If ≥1 keyword overlaps between proposition keywords and segment text → +0.03 similarity boost. No overlap → elevated floor of 0.35 instead of 0.32.
3. **Similarity floor:** Hard reject any match below the applicable threshold regardless of rank.
4. **Cross-domain penalty:** If proposition domain ≠ segment detected domain, apply −0.05 before ranking.
5. **LLM as discriminator:** Lower retrieval thresholds admit more candidates, but the stance extraction LLM classifies tangential matches as NEUTRAL or UNCLEAR. This two-stage design favors recall at retrieval and precision at extraction.

---

## 6. Stance Extraction

For each segment–proposition pair, an LLM classifies the segment's stance toward the policy proposition. The classifier determines whether the text **supports (PRO)**, **opposes (ANTI)**, is **genuinely balanced toward (NEUTRAL)**, or provides **insufficient signal about (UNCLEAR)** the proposition.

**Framing-aware extraction (v2):**

News articles reveal ideological stance not only through explicit advocacy but also through *framing* — editorial choices about source selection, emphasis, language, proportion, and omission. The stance extractor analyzes both explicit statements and implicit framing signals:

- **Source selection:** Quoting predominantly one-sided sources indicates a lean toward that side.
- **Language choices:** Loaded or partisan terminology ("tax relief" vs. "tax cuts", "undocumented" vs. "illegal") signals alignment.
- **Emphasis and proportion:** Devoting more space to one side's arguments indicates a lean.
- **Omission:** Discussing a policy without mentioning well-known counterarguments suggests alignment.
- **Attribution framing:** Distancing language ("critics claim") vs. legitimizing language ("experts note") reveals editorial positioning.

**Extraction rules:**

- Judgment based on both explicit text content and implicit framing signals — never from outlet identity, author, or publication.
- Sentiment (positive/negative tone) ≠ stance (policy position). A negative sentiment about a policy does not necessarily mean ANTI.
- NEUTRAL requires genuinely balanced treatment: roughly equal voice to both sides, or purely procedural content. One-sided source selection is not NEUTRAL.
- A relevant text span must justify the label. Minor paraphrasing is acceptable; the span is validated via fuzzy matching (case-insensitive, whitespace-normalized, with 80% ordered-word fallback for spans ≥ 3 words). Only spans failing both exact and fuzzy checks trigger UNCLEAR downgrade.

| Confidence Range | Meaning | Action |
|---|---|---|
| 0.90–1.00 | Explicit advocacy or direct policy endorsement | Accept as-is |
| 0.70–0.89 | Strong framing lean (clear source imbalance, loaded language) | Accept as-is |
| 0.50–0.69 | Detectable framing lean (subtle language, mild imbalance) | Accept, flag as low_confidence |
| 0.30–0.49 | Weak signal (slight phrasing hints) | Downgrade to UNCLEAR |
| < 0.30 | Negligible signal | Discard extraction entirely |

---

## 7. MAP IRT Estimation

The ideology score θ is estimated using **Maximum A Posteriori (MAP) estimation** under a Rasch (1PL) Item Response Theory model. This is the standard Bayes-modal IRT ability estimator (Birnbaum, 1969). In v1, all propositions share $a_i = 1.0$ (Rasch model); 2PL extension with calibrated discrimination parameters is planned for v2.

### Probability Model (Rasch / 1PL IRT)

The probability that document $d$ produces a liberal-aligned response ($y = 1$) on proposition $i$. In v1, $a_i = 1.0$ for all propositions (Rasch model), reducing to:

$$
P(y_{di} = 1 \mid \theta_d, b_i) = \sigma(\theta_d - b_i) = \frac{1}{1 + \exp(-(\theta_d - b_i))}
$$

Where $\theta_d$ = ideology score, $b_i$ = difficulty. $\sigma$ is the logistic sigmoid. In v1, $a_i = 1.0$ for all items (Rasch model).

### MAP Objective

We maximize the posterior = likelihood × prior, with a Gaussian prior $\theta \sim \mathcal{N}(0, \sigma^2 = 1.0)$:

$$
\mathcal{L}_{\text{MAP}}(\theta) = \sum_i \left[ y_i \cdot \log \sigma(\theta - b_i) + (1 - y_i) \cdot \log(1 - \sigma(\theta - b_i)) \right] - \frac{\theta^2}{2\sigma^2}
$$

The Gaussian prior ($\sigma = 1.0$) regularizes toward center when data is sparse, preventing extreme scores on 2–4 votes.

### Newton-Raphson Update

The MAP estimate is found iteratively (≤10 iterations, convergence tolerance 0.001):

$$
g = \sum_i (y_i - P_i) - \frac{\theta}{\sigma^2}
$$

$$
h = -\sum_i P_i(1 - P_i) - \frac{1}{\sigma^2}
$$

$$
\theta \leftarrow \theta - \frac{g}{h}
$$

Where $P_i = \sigma(\theta - b_i)$. Initialize $\theta_0 = 0$ (prior mean). Implementation includes a step-size cap and Hessian floor to prevent numerical instability when evidence is sparse.

### Normalization

The raw θ is mapped to $[-1, +1]$ for display:

$$
\theta_{\text{normalized}} = \tanh\!\left(\frac{\theta_{\text{raw}}}{2.0}\right)
$$

The hyperbolic tangent provides smooth compression with natural saturation at extremes.

### Standard Error

Computed from the final Hessian to quantify estimation uncertainty:

$$
\text{SE} = \sqrt{\frac{-1}{h}}
$$

Lower SE means more confident estimate. High SE with few stances indicates insufficient signal.

### Properties

- **Deterministic:** Same inputs → same output. No sampling, no randomness.
- **Fast:** 10 Newton steps on 5 propositions ≈ <1ms. Well within the 60s edge budget.
- **Calibratable:** When anchor data yields $b_i \neq 0$, the same algorithm works without modification.
- **Regularized:** The Gaussian prior prevents extreme scores when few stances are available.

### Minimum Signal Requirements

- Minimum 2 valid stances (PRO or ANTI with confidence ≥ 0.50) required for scoring
- At least 2 unique propositions must be matched
- All stances NEUTRAL/UNCLEAR → score is null (not zero)
- Single-domain coverage is permitted but flagged — the IRT standard error correctly reflects the higher uncertainty

The lower minimum (2 vs. 3 in v1) is safe because the Gaussian prior regularizes sparse estimates toward center and the standard error correctly reflects high uncertainty with few data points. Single-domain articles (e.g., an article exclusively about immigration policy) are common in news and produce valid single-axis ideology signals. The domain cap (40% maximum per domain) still applies when multiple domains are present.

---

## 8. Ideology Aggregation

### Document-Level θ

All valid stance votes across a document's segments are pooled and fed into a single MAP IRT computation. This produces a document-level θ that reflects the aggregate ideological positioning across all relevant policy domains.

### 2D Extension: Economic & Social Axes

θ is also computed independently for two dimensions by filtering propositions:

$$
\theta_{\text{economic}} = \text{MAP\_IRT}(\text{stances where dimension} = \texttt{economic})
$$

$$
\theta_{\text{social}} = \text{MAP\_IRT}(\text{stances where dimension} \in \{\texttt{social}, \texttt{executive}\})
$$

Minimum 2 stances per dimension required; otherwise that dimension is null.

| Dimension | −1 Pole | +1 Pole |
|---|---|---|
| Economic | Right-economic (free market, deregulation, low tax) | Left-economic (redistribution, regulation, labor) |
| Social | Authoritarian (social order, traditional values) | Libertarian (civil liberties, individual rights) |

### Publisher Rolling Ideology

Computed over a trailing 30-day window, weighted by stance count and confidence:

$$
\theta_{\text{pub}} = \frac{\sum(\theta_d \cdot w_d)}{\sum w_d} \quad \text{where} \quad w_d = n_{\text{stances}} \times \text{mean\_confidence}
$$

Requires ≥ 10 articles with valid $\theta_{\text{doc}}$ in the window. Otherwise: insufficient_data.

### Legacy Display Scale

For backwards compatibility, normalized θ $[-1, +1]$ is mapped to a $[-10, +10]$ display scale: `display = θ_normalized × 10`.

---

## 9. Factuality Scoring

Factuality is a composite metric derived from grounding, contradiction rate, sourcing quality, and editorialization. It blends four weighted dimensions into a single 0–100 score. Higher values indicate more factual, well-sourced, balanced reporting. **This is a composite statistical signal, not a determination of truthfulness.**

$$
\text{factuality} = 0.40 \cdot (1 - \text{contradiction\_rate}) + 0.25 \cdot \text{sourcing\_quality} + 0.25 \cdot \text{grounding} + 0.10 \cdot (1 - \text{editorialization})
$$

**Contradiction Rate (40%):** Let $V = S + C + M$ (segments with directional evidence). $\text{contradiction\_rate} = C / V$ — the proportion of directionally-verified segments that are contradicted. If $V < 3$, the factuality score is flagged as `low_sample` and displayed with an uncertainty badge rather than a definitive verdict.

**Sourcing Quality (25%):** Weighted average of evidence tier quality (T1–T5). Authoritative sources improve factuality.

**Grounding (25%):** Proportion of segments with retrievable evidence. Higher verifiability → higher factuality.

**Editorialization (10%):** Rhetorical intensity from opinion density, sentiment extremity, and classification imbalance. More balanced → higher factuality.

### Factuality Rating Levels

| Range | Rating | Description |
|---|---|---|
| 90–100 | Very High | Consistently factual, well-sourced, balanced |
| 75–89 | High | Reliable with minor sourcing or balance issues |
| 60–74 | Mostly Factual | Generally reliable, occasional issues |
| 40–59 | Mixed | Reliability varies, multiple issues |
| 20–39 | Low | Often unreliable, significant issues |
| 0–19 | Very Low | Consistently unreliable |

---

## 10. The Strip

The colored bar shown on each article is called the **Strip**. Each cell represents one segment, colored by its veracity label. Reading left to right, you see the evidence alignment of the entire document at a glance.

| Color | Label | Meaning |
|---|---|---|
| 🟢 Green | **Supported** | Retrieved evidence predominantly entails the segment's claims. |
| 🔴 Red | **Disputed** | Retrieved evidence predominantly contradicts the segment's claims. (Internal enum: `CONTRADICTED`; displayed as "Disputed" in the UI to reflect epistemic humility.) |
| 🟡 Yellow | **Mixed** | Retrieved evidence both supports and contradicts; no clear consensus. |
| ⚪ Gray | **Unknown** | Insufficient evidence retrieved to make a judgment. |
| 🟣 Purple | **Opinion** | Subjective analysis or editorial commentary. |
| ⬜ Light Gray | **Not Checkable** | Procedural or non-factual content. |
| 🔵 Blue | **Neutral** | Factual but with neutral NLI evidence alignment. |

---

## Glossary

| Term | Definition |
|---|---|
| **2PL IRT** | Two-Parameter Logistic Item Response Theory — a psychometric model used to estimate a latent trait (ideology θ) from binary responses. Each proposition has a discrimination parameter ($a_i$) and difficulty parameter ($b_i$). v1 uses the Rasch (1PL) special case where $a_i = 1.0$ for all items; 2PL calibration is planned for v2. |
| **Claim** | A discrete factual assertion extracted from a segment using the SIRE framework. Each claim is independently evaluated against retrieved evidence. |
| **Confidence Score** | A 0–1 value indicating how certain the NLI model is about its entailment / contradiction / neutral judgment for a given claim. |
| **Contradicted** | A segment or claim label meaning the retrieved evidence predominantly contradicts the assertion. Displayed as "Disputed" in the UI to reflect epistemic humility. (Internal: `CONTRADICTED`.) |
| **Cross-Domain Penalty** | A −0.05 cosine similarity adjustment applied when a proposition's policy domain does not match the segment's detected domain, reducing false-positive matches. |
| **Discrimination ($a_i$)** | An IRT parameter measuring how well a proposition separates liberal from conservative positions. Higher values mean the proposition is more informative. Set to 1.0 for all propositions in v1 (Rasch model). |
| **Difficulty ($b_i$)** | An IRT parameter representing the ideology level at which $P(y=1) = 0.5$ for a proposition. Set to 0.0 for all propositions in v1 (prior to calibration). |
| **Embedding** | A dense numerical vector (produced by text-embedding-3-small, 1536 dimensions) representing the semantic meaning of a text segment, used for similarity search. |
| **Evidence** | A passage retrieved from the corpus or the web that is used to evaluate a claim. Each piece of evidence is scored for similarity and NLI alignment. |
| **Evidence Tier** | A ranking from T1 (primary source) to T5 (internal corpus) indicating the provenance quality of evidence. T1 = Primary Source, T2 = Wire Service, T3 = Reference, T4 = Established News, T5 = Internal Corpus. |
| **Factual Claim** | A segment classification indicating the text contains verifiable assertions about the world, as opposed to opinions or procedural content. |
| **Factuality Score** | A 0–100 composite statistical signal blending contradiction rate (40%), sourcing quality (25%), grounding (25%), and editorialization (10%). Higher values indicate more factual, well-sourced, balanced reporting. This is not a determination of truthfulness. |
| **Grounding Score** | A 0–100 measure of evidence coverage: the proportion of a document's segments that have actual evidence. High grounding means most claims were testable; low grounding means many claims lacked evidence. |
| **Ideology Score (θ)** | A real-valued latent parameter estimated via MAP IRT. $\theta > 0$ = more liberal, $\theta < 0$ = more conservative, $\theta = 0$ = centrist. Normalized to $[-1, +1]$ via $\tanh(\theta/2)$ for display. |
| **Integrity Score** | A 0–100 weighted score reflecting evidence alignment. Supported segments contribute positively, contradicted segments incur a 1.2× penalty, and mixed segments contribute lightly. The asymmetric weighting is deliberately conservative. |
| **Keyword Boost** | A +0.03 cosine similarity bonus applied when a proposition's keywords overlap with segment text. Improves precision without collapsing recall. |
| **MAP Estimation** | Maximum A Posteriori estimation — finds the mode of the posterior distribution of θ given observed stances and a Gaussian prior. Computed via Newton-Raphson iteration. |
| **Mixed** | A segment label meaning the retrieved evidence both supports and contradicts the claims — no clear consensus among sources. |
| **Newton-Raphson** | An iterative numerical method used to find the MAP estimate of θ. Converges in ≤10 iterations with tolerance 0.001. |
| **NLI** | Natural Language Inference — a classification task where a model determines whether evidence entails, contradicts, or is neutral toward a given claim. |
| **Normalization** | The pipeline step where raw HTML/feed content is converted to clean markdown using Gemini flash-lite, stripping ads, navigation, and boilerplate. |
| **Editorialization Score** | A 0–100 metric measuring rhetorical intensity through opinion density (40%), sentiment extremity (35%), and classification imbalance (25%). Higher values indicate more editorialized presentation. Not an ideology measure. |
| **Opinion** | A segment classification meaning the text expresses subjective analysis, editorial commentary, or value judgments rather than checkable facts. |
| **Procedural** | A segment classification for instructional or how-to content that is not a factual claim about the world. |
| **Proposition** | A policy-principle-level declarative statement from the Proposition Bank (50 items across 10 domains) against which article segments are scored for stance. |
| **Proposition Bank** | A curated set of 50 policy propositions spanning 10 domains, each tagged with polarity (`liberal_is_pro`), domain, dimension, and IRT parameters. Embeddings enable vector retrieval. |
| **RAG Retrieval** | Retrieval-Augmented Generation — the process of finding relevant propositions for a segment via vector similarity search before stance extraction. |
| **Segment** | A contiguous chunk of a normalized document, typically one or two paragraphs, used as the atomic unit for classification and claim extraction. |
| **Sentiment** | An emotional-tone metric with four components: compound (−1 to +1), positive, negative, neutral (each 0 to 1). Computed by Gemini flash-lite. Supplementary context only. |
| **SIRE** | Scope · Information · Retrieval · Exclusions — a structured framework used to decompose each claim into searchable queries and constraints before evidence retrieval. |
| **Sourcing Quality Score** | A 0–100 metric rating evidence provenance. Weighted by tier: T1 (1.0), T2 (0.85), T3 (0.70), T4 (0.45), T5 (0.20). Penalized if fewer than 3 evidence pieces. |
| **Stance** | The extracted position of a segment toward a proposition: PRO (supports), ANTI (opposes), NEUTRAL (discusses without taking sides), or UNCLEAR (insufficient signal). |
| **Strip** | The colored bar at the top of each article card. Each cell represents one segment, colored by its veracity label, giving a visual fingerprint of evidence alignment. |
| **Supported** | A segment or claim label meaning the retrieved evidence predominantly entails (confirms) the assertion. |
| **Synthesis** | A machine-generated summary produced by Sonar that restates extracted claim-level results and their evidence alignment. Does not assert independent judgments. |
| **Theta (θ)** | The latent ideology parameter. Positive values indicate liberal positioning, negative values indicate conservative positioning. The MAP estimate is the mode of the posterior distribution. |
| **Unknown** | A veracity label assigned when insufficient evidence was retrieved to make an entailment or contradiction judgment. |
| **Veracity** | The evidence-alignment status of a claim, determined by NLI analysis. Labels: Supported, Contradicted, Mixed, Unknown, Not Checkable. |

---

## Limitations

All results reflect alignment between extracted claims and retrieved evidence at analysis time. They do not constitute definitive judgments of truth. Evidence retrieval is not exhaustive; the corpus and web sources available at the time of analysis may not represent the totality of relevant information. NLI model outputs are probabilistic and subject to error.

**Ideology scoring limitations:** Scores are computed only when stance signals (PRO/ANTI) are present. The v2 framing-aware extractor detects implicit editorial positioning through source selection, language, emphasis, and omission, significantly improving coverage over v1's explicit-only approach. Wire-style reporting with genuinely balanced framing will still produce fewer usable votes and wider standard errors. **A null score does not mean "centrist" — it means insufficient ideological signal was detected.**

**Framing detection trade-offs:** The framing-aware approach (v2) detects subtler ideological signals in news reporting, increasing scoring coverage. This also means that articles with mild, unintentional framing may receive non-null scores where v1 would have returned null. The confidence calibration and minimum-stance requirements mitigate this, but users should interpret scores with moderate confidence (0.50–0.69) as suggestive rather than definitive.

**Neutral-reporting coverage:** Because NEUTRAL and UNCLEAR stances are excluded from the IRT computation, articles with genuinely balanced framing produce fewer votes and more null scores. This is by design — the system correctly reflects uncertainty rather than forcing a centrist label — but users should expect lower ideology scoring rates for wire-service and straight-news content compared to editorial or advocacy content.

**Domain cap:** No single domain contributes > 40% of stances to any document's θ computation when multiple domains are present. If exceeded, the lowest-confidence stances from the over-represented domain are deterministically dropped until the cap is met. Single-domain articles are scored without the cap — single-topic coverage is expected for many news articles and the IRT standard error correctly reflects the narrower evidence base. This prevents high-salience issues (e.g., immigration, abortion) from dominating the ideology space in multi-domain articles while maintaining reproducibility.

**Proposition currency:** Six propositions are flagged for potential low discrimination or era-dependent polarity: military aid (#26), human rights sanctions (#29), free trade (#28), nuclear energy (#38), executive tariff authority (#41), and emergency declarations (#45). These are reviewed quarterly.

**Calibration status (v1):** Item parameters are set to defaults ($a_i = 1.0$, $b_i = 0.0$). Full calibration against politician anchor speeches (target Pearson $r \geq 0.65$) is in progress. Parameter updates will be versioned — old scores retain their `scoring_version` tag for reproducibility.

Factuality and ideology scores should be interpreted as statistical signals, not as editorial or legal determinations. Ideology score is orthogonal to veracity — they measure different things and do not influence each other.
