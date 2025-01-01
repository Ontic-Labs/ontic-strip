import {
  INTEGRITY_SUPPORTED_WEIGHT,
  INTEGRITY_CONTRADICTED_PENALTY,
  INTEGRITY_MIXED_WEIGHT,
  INTEGRITY_MIN_DENOMINATOR,
  SOURCING_TIER_WEIGHTS,
  SOURCING_MIN_EVIDENCE,
  ONESIDED_OPINION_WEIGHT,
  ONESIDED_SENTIMENT_WEIGHT,
  ONESIDED_CLASSIFICATION_WEIGHT,
  FACTUALITY_CONTRADICTION_WEIGHT,
  FACTUALITY_SOURCING_WEIGHT,
  FACTUALITY_GROUNDING_WEIGHT,
  FACTUALITY_ONESIDED_WEIGHT,
} from "./scoring-constants.ts";

export interface ScoreInputs {
  supported: number;
  contradicted: number;
  mixed: number;
  unknown: number;
  total: number;
}

export interface SourcingInputs {
  /** Count of evidence pieces per tier, e.g. { T1: 2, T2: 5, T4: 3 } */
  tierCounts: Record<string, number>;
}

export interface OneSidednessInputs {
  /** Ratio of OPINION_ANALYSIS segments to total segments (0–1) */
  opinionRatio: number;
  /** Absolute value of document-level sentiment compound (0–1) */
  sentimentExtremity: number;
  /** Ratio of FACTUAL_CLAIM segments to total segments (0–1) */
  factualRatio: number;
}

export interface PersistedScores {
  groundingScore: number;
  claimGroundingScore: number | null;
  integrityScore: number;
  integrityStatus: "ok" | "low_sample";
  sourcingQuality: number | null;
  oneSidedness: number | null;
  factualityScore: number | null;
  factualityStatus: "ok" | "low_sample" | null;
}

export function computeGroundingScore(inputs: ScoreInputs): number {
  if (inputs.total <= 0) return 0;
  return (inputs.supported + inputs.contradicted + inputs.mixed) / inputs.total;
}

export function computeIntegrityScore(inputs: ScoreInputs): number {
  const checkable = inputs.supported + inputs.contradicted + inputs.mixed + inputs.unknown;
  const denominator = Math.max(checkable, INTEGRITY_MIN_DENOMINATOR);

  const rawIntegrity = (
    inputs.supported * INTEGRITY_SUPPORTED_WEIGHT
    - inputs.contradicted * INTEGRITY_CONTRADICTED_PENALTY
    + inputs.mixed * INTEGRITY_MIXED_WEIGHT
  ) / denominator;

  const normalized =
    (rawIntegrity + INTEGRITY_CONTRADICTED_PENALTY)
    / (INTEGRITY_SUPPORTED_WEIGHT + INTEGRITY_CONTRADICTED_PENALTY);

  return Math.max(0, Math.min(1, normalized));
}

/**
 * Sourcing Quality Score (0–1). Higher = better sourced.
 * Weighted average of evidence tier quality, penalized if too few evidence pieces.
 */
export function computeSourcingQuality(inputs: SourcingInputs): number {
  const entries = Object.entries(inputs.tierCounts);
  if (entries.length === 0) return 0;

  let totalWeight = 0;
  let totalCount = 0;
  for (const [tier, count] of entries) {
    const w = SOURCING_TIER_WEIGHTS[tier] ?? 0.2;
    totalWeight += w * count;
    totalCount += count;
  }

  if (totalCount === 0) return 0;

  let score = totalWeight / totalCount;

  // Penalize sparse sourcing
  if (totalCount < SOURCING_MIN_EVIDENCE) {
    score *= totalCount / SOURCING_MIN_EVIDENCE;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * One-Sidedness Score (0–1). Higher = more one-sided/biased presentation.
 * Combines opinion density, sentiment extremity, and classification imbalance.
 */
export function computeOneSidedness(inputs: OneSidednessInputs): number {
  // Classification imbalance: absolute difference between factual and opinion ratios
  const classImbalance = Math.abs(inputs.opinionRatio - inputs.factualRatio);

  const score =
    inputs.opinionRatio * ONESIDED_OPINION_WEIGHT +
    inputs.sentimentExtremity * ONESIDED_SENTIMENT_WEIGHT +
    classImbalance * ONESIDED_CLASSIFICATION_WEIGHT;

  return Math.max(0, Math.min(1, score));
}

/**
 * Factuality Composite Score (0–1). Higher = more factual/reliable.
 * Weighted blend inspired by MBFC's factuality formula.
 */
export function computeFactualityScore(
  contradictionRate: number,
  sourcingQuality: number,
  groundingScore: number,
  oneSidedness: number,
): number {
  // Invert contradiction and one-sidedness (lower is better for factuality)
  const factCheckComponent = 1 - contradictionRate;
  const onesidedComponent = 1 - oneSidedness;

  const score =
    factCheckComponent * FACTUALITY_CONTRADICTION_WEIGHT +
    sourcingQuality * FACTUALITY_SOURCING_WEIGHT +
    groundingScore * FACTUALITY_GROUNDING_WEIGHT +
    onesidedComponent * FACTUALITY_ONESIDED_WEIGHT;

  return Math.max(0, Math.min(1, score));
}

export function roundScore3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface ClaimGroundingInputs {
  supportedClaims: number;
  contradictedClaims: number;
  mixedClaims: number;
  totalClaims: number;
}

export function computeClaimGrounding(inputs: ClaimGroundingInputs): number {
  if (inputs.totalClaims <= 0) return 0;
  return (inputs.supportedClaims + inputs.contradictedClaims + inputs.mixedClaims) / inputs.totalClaims;
}

export function computePersistedScores(
  inputs: ScoreInputs,
  sourcingInputs?: SourcingInputs,
  oneSidednessInputs?: OneSidednessInputs,
  claimGroundingInputs?: ClaimGroundingInputs,
): PersistedScores {
  const groundingScore = roundScore3(computeGroundingScore(inputs));
  const integrityScore = roundScore3(computeIntegrityScore(inputs));

  // Low-sample detection: checkable segments < 3
  const checkable = inputs.supported + inputs.contradicted + inputs.mixed + inputs.unknown;
  const integrityStatus: "ok" | "low_sample" = checkable < 3 ? "low_sample" : "ok";

  // Claim-level grounding
  const claimGroundingScore = claimGroundingInputs
    ? roundScore3(computeClaimGrounding(claimGroundingInputs))
    : null;

  let sourcingQuality: number | null = null;
  let oneSidedness: number | null = null;
  let factualityScore: number | null = null;
  let factualityStatus: "ok" | "low_sample" | null = null;

  if (sourcingInputs) {
    sourcingQuality = roundScore3(computeSourcingQuality(sourcingInputs));
  }

  if (oneSidednessInputs) {
    oneSidedness = roundScore3(computeOneSidedness(oneSidednessInputs));
  }

  if (sourcingQuality !== null && oneSidedness !== null) {
    const V = inputs.supported + inputs.contradicted + inputs.mixed;
    const contradictionRate = V > 0
      ? inputs.contradicted / V
      : 0;
    factualityScore = roundScore3(
      computeFactualityScore(contradictionRate, sourcingQuality, groundingScore, oneSidedness)
    );
    // Factuality low_sample when directionally-verified segments (V = S+C+M) < 3
    factualityStatus = V < 3 ? "low_sample" : "ok";
  }

  return {
    groundingScore,
    claimGroundingScore,
    integrityScore,
    integrityStatus,
    sourcingQuality,
    oneSidedness,
    factualityScore,
    factualityStatus,
  };
}
