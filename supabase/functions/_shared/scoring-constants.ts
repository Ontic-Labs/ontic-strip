// =============================================================
// Centralized scoring constants for the entire pipeline.
// Every magic number lives here so audits are one-file affairs.
// =============================================================

// --------------- Evidence Retrieval ---------------

/** Embedding model used for claim→segment similarity search */
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";

/** Minimum cosine similarity to consider a segment as potential evidence */
export const SIMILARITY_THRESHOLD = 0.25;

/** Maximum evidence segments stored per claim */
export const MAX_EVIDENCE_PER_CLAIM = 5;

/** Extra segments fetched beyond MAX to allow for dedupe filtering */
export const EVIDENCE_FETCH_HEADROOM = 3;

/** Jaccard / embedding similarity above which evidence is flagged as non-independent (echo) */
export const NEAR_DUPLICATE_THRESHOLD = 0.92;

// --------------- Domain → Tier Maps ---------------

export const OFFICIAL_DOMAINS = new Set([
  "whitehouse.gov", "archives.gov", "congress.gov", "govinfo.gov",
  "sec.gov", "bls.gov", "bea.gov", "treasury.gov", "who.int", "un.org",
  "state.gov", "defense.gov", "judiciary.gov", "supremecourt.gov",
  "ecb.europa.eu", "imf.org", "worldbank.org",
]);

export const WIRE_DOMAINS = new Set([
  "reuters.com", "apnews.com", "afp.com", "upi.com",
]);

export const REFERENCE_DOMAINS = new Set([
  "wikipedia.org", "britannica.com", "snopes.com", "politifact.com",
  "factcheck.org",
]);

/** Numeric rank for each tier (lower = stronger) */
export const TIER_RANK: Record<string, number> = {
  T1: 1, T2: 2, T3: 3, T4: 4, T5: 5,
};

// --------------- Scope-Match Gate ---------------

/** Minimum Jaccard overlap for evidence to pass scope check (applied to both support and contradiction) */
export const SCOPE_JACCARD_MIN = 0.12;

/** Minimum embedding similarity for evidence to pass scope check (applied to both support and contradiction) */
export const SCOPE_EMBEDDING_SIM_MIN = 0.55;

/** Tighter Jaccard threshold for legal/regulatory claims */
export const SCOPE_LEGAL_JACCARD_MIN = 0.18;

/** Tighter Jaccard threshold for geopolitical event claims (action + location must match) */
export const SCOPE_GEOPOLITICAL_JACCARD_MIN = 0.15;

/** Max confidence assigned to scope-failed evidence downgraded to NEUTRAL */
export const SCOPE_FAIL_CONFIDENCE_CAP = 0.55;

// --------------- Veracity Computation ---------------

/** Both sides must be at least this strong to trigger MIXED */
export const MIXED_MIN_STRENGTH = 0.50;

/** Max delta between support and contradict avg confidence to allow MIXED */
export const MIXED_MAX_DELTA = 0.25;

/** Minimum avg confidence for pure contradiction to count */
export const CONTRADICTION_MIN_CONF = 0.55;

/** Minimum avg confidence for pure support to count */
export const SUPPORT_MIN_CONF = 0.50;

/** Confidence cap when only T4/T5 evidence supports a claim */
export const LOW_TIER_SUPPORT_CONFIDENCE_CAP = 0.60;

// --------------- Risk-Based Tier Gating ---------------

/** CRITICAL claims require evidence at or above this tier rank (T1 or T2) */
export const CRITICAL_MAX_TIER_RANK = 2;

/** HIGH claims require evidence at or above this tier rank (T1, T2, or T3) */
export const HIGH_MAX_TIER_RANK = 3;

/** Confidence assigned to a risk-gated CRITICAL claim */
export const CRITICAL_GATED_CONFIDENCE = 0.30;

/** Confidence assigned to a risk-gated HIGH claim */
export const HIGH_GATED_CONFIDENCE = 0.40;

/** Tier rank at or above which the low-tier confidence cap applies */
export const LOW_TIER_THRESHOLD = 4;

// --------------- Weighted Segment Label Resolution ---------------

/** Weight multiplier for SUPPORTED claims in segment scoring */
export const SEGMENT_WEIGHT_SUPPORTED = 1.0;

/** Weight multiplier for CONTRADICTED claims (higher = more punitive) */
export const SEGMENT_WEIGHT_CONTRADICTED = 1.2;

/** Weight multiplier for MIXED claims */
export const SEGMENT_WEIGHT_MIXED = 0.1;

/** If both pos and neg mass exceed this, segment is MIXED */
export const SEGMENT_MIXED_MASS_THRESHOLD = 0.9;

/** Net score above this → SUPPORTED */
export const SEGMENT_SUPPORTED_THRESHOLD = 0.6;

/** Net score below negative of this → CONTRADICTED */
export const SEGMENT_CONTRADICTED_THRESHOLD = -0.6;

// --------------- Aggregator (Document-Level Integrity) ---------------

/** Weight of SUPPORTED segments in integrity formula (positive) */
export const INTEGRITY_SUPPORTED_WEIGHT = 1.0;

/** Weight of CONTRADICTED segments in integrity formula (negative penalty, matches segment weight) */
export const INTEGRITY_CONTRADICTED_PENALTY = 1.2;

/** Weight of MIXED segments in integrity formula */
export const INTEGRITY_MIXED_WEIGHT = 0.25;

/** Minimum denominator to prevent small-sample score explosion */
export const INTEGRITY_MIN_DENOMINATOR = 3;

// --------------- Sourcing Quality (MBFC-inspired) ---------------

/** Weight map for evidence tiers in sourcing quality calculation.
 *  Higher tier = better sourcing. Scale 0–1. */
export const SOURCING_TIER_WEIGHTS: Record<string, number> = {
  T1: 1.0,   // Primary/Official sources
  T2: 0.85,  // Wire services / official record
  T3: 0.70,  // Reference / fact-checkers
  T4: 0.45,  // Established news
  T5: 0.20,  // Internal corpus
};

/** Documents with fewer evidence pieces than this get a sourcing penalty */
export const SOURCING_MIN_EVIDENCE = 3;

// --------------- One-Sidedness (MBFC-inspired) ---------------

/** Weight of opinion ratio in one-sidedness formula */
export const ONESIDED_OPINION_WEIGHT = 0.40;

/** Weight of sentiment extremity in one-sidedness formula */
export const ONESIDED_SENTIMENT_WEIGHT = 0.35;

/** Weight of classification imbalance in one-sidedness formula */
export const ONESIDED_CLASSIFICATION_WEIGHT = 0.25;

// --------------- Factuality Composite (MBFC-inspired) ---------------

/** Weight of contradiction rate in factuality formula (maps to MBFC Failed Fact Checks 40%) */
export const FACTUALITY_CONTRADICTION_WEIGHT = 0.40;

/** Weight of sourcing quality in factuality formula (maps to MBFC Sourcing 25%) */
export const FACTUALITY_SOURCING_WEIGHT = 0.25;

/** Weight of grounding in factuality formula (maps to MBFC Transparency 25%) */
export const FACTUALITY_GROUNDING_WEIGHT = 0.25;

/** Weight of one-sidedness in factuality formula (maps to MBFC One-Sidedness 10%) */
export const FACTUALITY_ONESIDED_WEIGHT = 0.10;

// --------------- LLM Config ---------------
// Model, temperature, and max_tokens are now managed in prompt-registry.ts.
// See: _shared/prompt-registry.ts
