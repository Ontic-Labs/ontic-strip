export type SourceCategory = "mainstream" | "partisan" | "fringe" | "reference";
type FetchStatus = "pending" | "fetched" | "normalized" | "failed";
export type PipelineStatus =
  | "normalizing"
  | "pending"
  | "indexing"
  | "classifying"
  | "extracting"
  | "verifying"
  | "aggregated"
  | "failed";
type SegmentClassification = "FACTUAL_CLAIM" | "OPINION_ANALYSIS" | "PROCEDURAL" | "OTHER";
export type SegmentLabel =
  | "SUPPORTED"
  | "CONTRADICTED"
  | "MIXED"
  | "UNKNOWN"
  | "NOT_CHECKABLE"
  | "OPINION"
  | "NEUTRAL"
  | "OTHER";
export type VeracityLabel = "SUPPORTED" | "CONTRADICTED" | "MIXED" | "UNKNOWN" | "NOT_CHECKABLE";
export type EvidenceTier = "T1" | "T2" | "T3" | "T4" | "T5";
type NLILabel = "ENTAILMENT" | "CONTRADICTION" | "NEUTRAL";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type GapReason =
  | "NO_RELEVANT_EVIDENCE"
  | "CIRCULAR_ONLY"
  | "EVIDENCE_CONFLICT"
  | "INSUFFICIENT_TIER_FOR_RISK"
  | "PRIMARY_SOURCE_NOT_RETRIEVED"
  | "NEUTRAL_ONLY"
  | "WEAK_SUPPORT"
  | "WEAK_CONTRADICTION"
  | "WEAK_CONFLICT";

export interface Feed {
  id: string;
  url: string;
  publisher_name: string;
  description: string | null;
  source_category: SourceCategory;
  polling_interval_minutes: number;
  last_polled_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  locale: string;
}

export interface Document {
  id: string;
  feed_id: string;
  url: string;
  title: string | null;
  author: string | null;
  published_at: string | null;
  raw_content: string | null;
  normalized_content: string | null;
  word_count: number | null;
  fetch_status: FetchStatus;
  pipeline_status: PipelineStatus;
  strip: StripCell[] | null;
  grounding_score: number | null;
  integrity_score: number | null;
  sourcing_quality: number | null;
  one_sidedness: number | null;
  factuality_score: number | null;
  ideology_scores: {
    economic: number | null;
    social: number | null;
    confidence?: number | null;
    reasoning?: string;
    method?: string;
    theta_raw?: number | null;
    se?: number | null;
    n_stances?: number;
    n_propositions?: number;
    scoring_version?: number;
    reason?: string;
  } | null;
  sentiment_compound: number | null;
  sentiment_pos: number | null;
  sentiment_neg: number | null;
  sentiment_neu: number | null;
  synthesis_text: string | null;
  synthesis_sources: string[] | null;
  created_at: string;
  updated_at: string;
  // Joined
  feeds?: Feed;
}

export interface StripCell {
  label: SegmentLabel;
  segment_id: string;
}

export interface Segment {
  id: string;
  document_id: string;
  position_index: number;
  text_content: string;
  token_count: number | null;
  classification: SegmentClassification | null;
  rhetorical_flags: string[];
  label: SegmentLabel | null;
  sentiment_compound: number | null;
  sentiment_pos: number | null;
  sentiment_neg: number | null;
  sentiment_neu: number | null;
  created_at: string;
}

export interface Claim {
  id: string;
  segment_id: string;
  document_id: string;
  claim_text: string;
  sire_scope: Record<string, unknown>;
  sire_information: Record<string, unknown>;
  sire_retrieval: Record<string, unknown>;
  sire_exclusions: Record<string, unknown>;
  veracity_label: VeracityLabel | null;
  confidence_score: number | null;
  risk_level: RiskLevel | null;
  gap_reason: GapReason | null;
  conflict_basis: string | null;
  created_at: string;
}

export interface Evidence {
  id: string;
  claim_id: string;
  source_segment_id: string | null;
  evidence_text: string;
  source_tier: EvidenceTier;
  source_url: string | null;
  source_publisher: string | null;
  similarity_score: number | null;
  nli_label: NLILabel | null;
  nli_confidence: number | null;
  is_independent: boolean;
  created_at: string;
}

export interface PublisherBaseline {
  id: string;
  publisher_name: string;
  period: "7d" | "30d";
  avg_grounding_score: number | null;
  avg_integrity_score: number | null;
  avg_contradiction_rate: number | null;
  avg_sourcing_quality: number | null;
  avg_one_sidedness: number | null;
  avg_factuality_score: number | null;
  avg_ideology_economic: number | null;
  avg_ideology_social: number | null;
  segment_label_distribution: Record<string, number>;
  document_count: number;
  computed_at: string;
}

export const STRIP_COLORS: Record<SegmentLabel, string> = {
  SUPPORTED: "bg-strip-supported",
  CONTRADICTED: "bg-strip-contradicted",
  MIXED: "bg-strip-mixed",
  UNKNOWN: "bg-strip-unknown",
  NOT_CHECKABLE: "bg-strip-not-checkable",
  OPINION: "bg-strip-opinion",
  NEUTRAL: "bg-strip-neutral",
  OTHER: "bg-strip-neutral",
};

export const STRIP_LABEL_NAMES: Record<SegmentLabel, string> = {
  SUPPORTED: "Supported",
  CONTRADICTED: "Disputed",
  MIXED: "Mixed",
  UNKNOWN: "Unknown",
  NOT_CHECKABLE: "Not Checkable",
  OPINION: "Opinion",
  NEUTRAL: "Neutral",
  OTHER: "Other",
};

export const TIER_NAMES: Record<EvidenceTier, string> = {
  T1: "Primary Source",
  T2: "Wire Service",
  T3: "Reference",
  T4: "Established News Organization",
  T5: "Internal Corpus",
};

export const RISK_LEVEL_NAMES: Record<RiskLevel, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
};

export const GAP_REASON_NAMES: Record<GapReason, string> = {
  NO_RELEVANT_EVIDENCE: "No relevant evidence found",
  CIRCULAR_ONLY: "Only circular/self-referential evidence",
  EVIDENCE_CONFLICT: "Sources conflict",
  INSUFFICIENT_TIER_FOR_RISK: "Insufficient evidence tier for claim risk",
  PRIMARY_SOURCE_NOT_RETRIEVED: "Primary source not retrieved",
  NEUTRAL_ONLY: "Evidence found but inconclusive",
  WEAK_SUPPORT: "Supporting evidence too weak",
  WEAK_CONTRADICTION: "Contradicting evidence too weak",
  WEAK_CONFLICT: "Conflicting evidence but neither side strong enough",
};

export const STRIP_LABEL_DESCRIPTIONS: Record<SegmentLabel, string> = {
  SUPPORTED: "Claim backed by independent evidence",
  CONTRADICTED: "Evidence contradicts this claim",
  MIXED: "Some evidence supports, some contradicts",
  UNKNOWN: "No sufficient evidence found",
  OPINION: "Editorial opinion or analysis",
  NOT_CHECKABLE: "Cannot be verified against evidence",
  NEUTRAL: "Informational, not a factual claim",
  OTHER: "Does not fit other categories",
};
