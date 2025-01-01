// =============================================================
// Proposition-Based Ideology Scoring Constants (v1.1)
// Centralized parameters per the technical design doc.
// =============================================================

// --------------- RAG Retrieval ---------------

/** Final propositions after filtering */
export const PROP_TOP_K_FINAL = 5;

/** Base cosine similarity threshold (with keyword overlap) */
export const PROP_SIM_THRESHOLD = 0.40;

/** Elevated threshold when no keyword overlap */
export const PROP_SIM_THRESHOLD_NO_KEYWORDS = 0.42;

/** Cross-domain similarity penalty */
export const CROSS_DOMAIN_PENALTY = 0.05;

/** Keyword overlap soft boost */
export const KEYWORD_BOOST = 0.02;

// --------------- Stance Extraction ---------------

/** Accept but flag as low_confidence */
export const STANCE_CONFIDENCE_LOW = 0.50;

/** Below this: downgrade to UNCLEAR */
export const STANCE_CONFIDENCE_UNCLEAR = 0.30;

/** Minimum segment token count for stance extraction */
export const STANCE_MIN_SEGMENT_TOKENS = 20;

// --------------- MAP IRT Scoring ---------------

/** Gaussian prior variance on θ */
export const IRT_PRIOR_SIGMA_SQ = 1.0;

/** Newton-Raphson max iterations */
export const IRT_MAX_ITER = 10;

/** Newton-Raphson convergence tolerance */
export const IRT_CONVERGENCE_TOL = 0.001;

/** Minimum valid stances (PRO/ANTI, conf ≥ 0.50) for scoring */
export const IRT_MIN_STANCES = 3;

/** Current scoring version */
export const IDEOLOGY_SCORING_VERSION = 1;

/** Maximum contribution from any single domain (40%) */
export const DOMAIN_CAP_FRACTION = 0.40;
