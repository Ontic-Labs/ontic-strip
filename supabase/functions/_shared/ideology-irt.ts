// =============================================================
// MAP IRT (2PL/Rasch) Ideology Estimator — Newton-Raphson
// Per §4.3 of the Proposition-Based Ideology Scoring v1.1 spec.
// =============================================================

import {
  IRT_PRIOR_SIGMA_SQ,
  IRT_MAX_ITER,
  IRT_CONVERGENCE_TOL,
  IRT_MIN_STANCES,
  STANCE_CONFIDENCE_LOW,
} from "./ideology-constants.ts";

export interface StanceVote {
  proposition_id: string;
  stance: "PRO" | "ANTI" | "NEUTRAL" | "UNCLEAR";
  confidence: number;
  liberal_is_pro: boolean;
  difficulty_b: number;
  domain?: string;
}

export interface IdeologyResult {
  score: number | null;
  theta_raw: number | null;
  se: number | null;
  n_propositions: number;
  mean_confidence: number;
  iterations: number;
  method: "map_irt" | "stance_average_proxy";
  reason?: string;
}

/**
 * Compute ideology score via MAP estimation (Newton-Raphson).
 * θ > 0 = liberal, θ < 0 = conservative.
 * Returns normalized score in [-1, +1] via tanh(θ/2).
 */
export function computeIdeologyMap(votes: StanceVote[]): IdeologyResult {
  // Filter to usable stances: PRO/ANTI with confidence ≥ 0.50
  const valid = votes.filter(
    (v) =>
      (v.stance === "PRO" || v.stance === "ANTI") &&
      v.confidence >= STANCE_CONFIDENCE_LOW
  );

  if (valid.length < IRT_MIN_STANCES) {
    return {
      score: null,
      theta_raw: null,
      se: null,
      n_propositions: valid.length,
      mean_confidence: valid.length > 0
        ? valid.reduce((s, v) => s + v.confidence, 0) / valid.length
        : 0,
      iterations: 0,
      method: "map_irt",
      reason: "insufficient_signal",
    };
  }

  // Encode to binary y_i per polarity contract (§4.1)
  const encoded = valid.map((v) => {
    let y: number;
    if (v.liberal_is_pro) {
      y = v.stance === "PRO" ? 1 : 0;
    } else {
      y = v.stance === "PRO" ? 0 : 1;
    }
    return { y, b_i: v.difficulty_b, conf: v.confidence };
  });

  // MAP estimation via Newton-Raphson
  let theta = 0.0;
  let h = 0.0;
  let iter = 0;

  for (iter = 0; iter < IRT_MAX_ITER; iter++) {
    let g = 0.0;
    h = 0.0;

    for (const v of encoded) {
      const p = 1.0 / (1.0 + Math.exp(-(theta - v.b_i)));
      g += v.y - p;
      h += -p * (1.0 - p);
    }

    // Prior terms
    g -= theta / IRT_PRIOR_SIGMA_SQ;
    h -= 1.0 / IRT_PRIOR_SIGMA_SQ;

    // Hessian floor: prevent division by near-zero when evidence is sparse
    const hSafe = Math.min(h, -0.01);

    // Newton step with step-size cap for numerical stability
    const rawDelta = g / hSafe;
    const MAX_STEP = 2.0;
    const delta = Math.max(-MAX_STEP, Math.min(MAX_STEP, rawDelta));
    theta -= delta;

    if (Math.abs(delta) < IRT_CONVERGENCE_TOL) {
      iter++;
      break;
    }
  }

  // Normalize to [-1, +1]
  const score = Math.tanh(theta / 2.0);

  // Standard error from final Hessian (using safe floor)
  const hSafe = Math.min(h, -0.01);
  const se = Math.sqrt(-1.0 / hSafe);

  const meanConf =
    encoded.reduce((s, v) => s + v.conf, 0) / encoded.length;

  return {
    score: Math.round(score * 10000) / 10000,
    theta_raw: Math.round(theta * 10000) / 10000,
    se: Math.round(se * 10000) / 10000,
    n_propositions: encoded.length,
    mean_confidence: Math.round(meanConf * 10000) / 10000,
    iterations: iter,
    method: "map_irt",
  };
}

/**
 * v0 fallback: simple stance-average proxy (NOT the production estimator).
 * Retained for debugging/comparison only.
 */
export function computeIdeologyV0Proxy(votes: StanceVote[]): IdeologyResult {
  const valid = votes.filter(
    (v) =>
      (v.stance === "PRO" || v.stance === "ANTI") &&
      v.confidence >= STANCE_CONFIDENCE_LOW
  );

  if (valid.length < IRT_MIN_STANCES) {
    return {
      score: null,
      theta_raw: null,
      se: null,
      n_propositions: valid.length,
      mean_confidence: 0,
      iterations: 0,
      method: "stance_average_proxy",
      reason: "insufficient_signal",
    };
  }

  let numerator = 0;
  let denominator = 0;
  for (const v of valid) {
    let encoded: number;
    if (v.liberal_is_pro) {
      encoded = v.stance === "PRO" ? 1 : -1;
    } else {
      encoded = v.stance === "PRO" ? -1 : 1;
    }
    numerator += encoded * v.confidence;
    denominator += v.confidence;
  }

  const raw = numerator / denominator;
  const score = Math.tanh(raw * 1.5);

  return {
    score: Math.round(score * 10000) / 10000,
    theta_raw: Math.round(raw * 10000) / 10000,
    se: null,
    n_propositions: valid.length,
    mean_confidence:
      Math.round(
        (valid.reduce((s, v) => s + v.confidence, 0) / valid.length) * 10000
      ) / 10000,
    iterations: 0,
    method: "stance_average_proxy",
  };
}
