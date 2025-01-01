import { AppLayout } from "@/components/layout/AppLayout";
import { IdeologyBadge } from "@/components/strip/IdeologyBadge";
import { PipelineStatusBadge } from "@/components/strip/PipelineStatusBadge";
import { ScoreBadge } from "@/components/strip/ScoreBadge";
import { StripBar } from "@/components/strip/StripBar";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";

import { ArticleCard } from "@/components/feed/ArticleCard";
import { SentimentBadge } from "@/components/strip/SentimentBadge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BASE_URL, SEOHead, newsArticleSchema } from "@/lib/seo";
import {
  GAP_REASON_NAMES,
  RISK_LEVEL_NAMES,
  STRIP_COLORS,
  STRIP_LABEL_NAMES,
  TIER_NAMES,
} from "@/lib/types";
import type {
  Claim,
  Document,
  Evidence,
  EvidenceTier,
  GapReason,
  RiskLevel,
  Segment,
  SegmentLabel,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { Check, ClipboardCopy } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/** Small inline score bar for a single segment */
function SegmentScoreBar({ claims }: { claims: Claim[] }) {
  if (claims.length === 0) return null;

  const scored = claims.filter((c) => c.veracity_label);
  if (scored.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const c of scored) {
    const v = c.veracity_label!;
    counts[v] = (counts[v] || 0) + 1;
  }

  const total = scored.length;

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <div className="flex h-1.5 w-20 rounded-full overflow-hidden gap-px">
        {Object.entries(counts).map(([label, count]) => (
          <div
            key={label}
            className={cn(STRIP_COLORS[label as SegmentLabel])}
            style={{ flex: count / total }}
          />
        ))}
      </div>
      <span className="text-[10px] font-mono text-muted-foreground">
        {scored.length}/{claims.length}
      </span>
    </div>
  );
}

/** Veracity badge with color coding */
function VeracityBadge({ label }: { label: string }) {
  const displayName: Record<string, string> = {
    SUPPORTED: "Supported",
    CONTRADICTED: "Disputed",
    MIXED: "Mixed",
    UNKNOWN: "Unknown",
    NOT_CHECKABLE: "Not Checkable",
  };
  const colorMap: Record<string, string> = {
    SUPPORTED: "bg-strip-supported/20 text-strip-supported border-strip-supported/30",
    CONTRADICTED: "bg-strip-contradicted/20 text-strip-contradicted border-strip-contradicted/30",
    MIXED: "bg-strip-mixed/20 text-strip-mixed border-strip-mixed/30",
    UNKNOWN: "bg-strip-unknown/20 text-strip-unknown border-strip-unknown/30",
  };
  return (
    <Badge variant="outline" className={cn("text-xs h-5 border", colorMap[label] || "")}>
      {displayName[label] || label}
    </Badge>
  );
}

export default function DocumentDetail() {
  const { id } = useParams<{ id: string }>();
  const [expandedSegment, setExpandedSegment] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("segments");
  const [copied, setCopied] = useState(false);
  const [highlightedSegment, setHighlightedSegment] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const { data: doc } = useQuery({
    queryKey: ["document", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("documents")
        .select("*, feeds(*)")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data as unknown as Document;
    },
    enabled: !!id,
  });

  const { data: segments } = useQuery({
    queryKey: ["segments", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("segments")
        .select("*")
        .eq("document_id", id!)
        .order("position_index");
      if (error) throw error;
      return data as unknown as Segment[];
    },
    enabled: !!id,
  });

  const { data: claims } = useQuery({
    queryKey: ["claims", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("claims").select("*").eq("document_id", id!);
      if (error) throw error;
      return data as unknown as Claim[];
    },
    enabled: !!id,
  });

  const { data: evidence } = useQuery({
    queryKey: ["evidence", id],
    queryFn: async () => {
      if (!claims?.length) return [];
      const claimIds = claims.map((c) => c.id);
      const { data, error } = await supabase.from("evidence").select("*").in("claim_id", claimIds);
      if (error) throw error;
      return data as unknown as Evidence[];
    },
    enabled: !!claims?.length,
  });

  // Find related articles from the same event
  const { data: relatedDocs } = useQuery({
    queryKey: ["related-documents", id],
    queryFn: async () => {
      // Get document's event_id
      const { data: doc } = await (supabase as any)
        .from("documents")
        .select("event_id")
        .eq("id", id!)
        .single();

      if (!doc?.event_id) return [];

      const { data: relatedArticles } = await (supabase as any)
        .from("documents")
        .select("*, feeds(*)")
        .eq("event_id", doc.event_id)
        .neq("id", id!)
        .order("published_at", { ascending: false });

      return (relatedArticles ?? []) as unknown as Document[];
    },
    enabled: !!id,
  });

  // copyAllContent defined after articleInsights below

  const publisherName = doc?.feeds?.publisher_name ?? "Unknown";

  const getClaimsForSegment = (segmentId: string) =>
    claims?.filter((c) => c.segment_id === segmentId) ?? [];

  const getEvidenceForClaim = (claimId: string) =>
    evidence?.filter((e) => e.claim_id === claimId) ?? [];

  // Build footnote index: unique source URLs from all evidence, numbered sequentially
  const footnoteMap = new Map<string, number>(); // url -> footnote number
  const footnoteList: { num: number; url: string; publisher: string | null }[] = [];
  if (evidence?.length) {
    for (const ev of evidence) {
      const url = ev.source_url;
      if (url && !footnoteMap.has(url)) {
        const num = footnoteList.length + 1;
        footnoteMap.set(url, num);
        footnoteList.push({ num, url, publisher: ev.source_publisher });
      }
    }
  }

  // Get footnote numbers for a segment (via its claims' evidence)
  const getFootnotesForSegment = (segmentId: string): number[] => {
    const segClaims = getClaimsForSegment(segmentId);
    const nums = new Set<number>();
    for (const c of segClaims) {
      for (const ev of getEvidenceForClaim(c.id)) {
        if (ev.source_url && footnoteMap.has(ev.source_url)) {
          nums.add(footnoteMap.get(ev.source_url)!);
        }
      }
    }
    return [...nums].sort((a, b) => a - b);
  };

  const articleInsights = useMemo(() => {
    const allSegments = segments ?? [];
    const allClaims = claims ?? [];

    const totalSegments = allSegments.length;
    const unknownSegments = allSegments.filter((s) => s.label === "UNKNOWN").length;
    const contradictedSegments = allSegments.filter((s) => s.label === "CONTRADICTED").length;
    const coveredSegments = allSegments.filter(
      (s) => s.label === "SUPPORTED" || s.label === "CONTRADICTED" || s.label === "MIXED",
    ).length;
    // Checkable = segments that could receive a directional verdict (excl. opinion/procedural/other)
    const checkableSegments = allSegments.filter(
      (s) =>
        s.label === "SUPPORTED" ||
        s.label === "CONTRADICTED" ||
        s.label === "MIXED" ||
        s.label === "UNKNOWN",
    ).length;

    // Rates use checkable denominator to match methodology & backend (§9)
    const unknownRate = checkableSegments > 0 ? unknownSegments / checkableSegments : 0;
    // Contradiction rate uses V = S+C+M (directionally-verified) to match scoring-math.ts
    const contradictionRate = coveredSegments > 0 ? contradictedSegments / coveredSegments : 0;

    const confidenceValues = allClaims
      .map((c) => c.confidence_score)
      .filter((value): value is number => value !== null && value !== undefined);
    const avgConfidence =
      confidenceValues.length > 0
        ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
        : null;

    const confidenceBand =
      avgConfidence === null
        ? "No confidence data"
        : avgConfidence >= 0.75
          ? "High confidence band"
          : avgConfidence >= 0.55
            ? "Medium confidence band"
            : "Low confidence band";

    const hasInsufficientEvidenceRisk = allClaims.some(
      (c) => c.gap_reason === "INSUFFICIENT_TIER_FOR_RISK",
    );

    const segmentContributions = allSegments.map((segment) => {
      let contribution = 0;
      if (segment.label === "SUPPORTED") contribution = 1.0;
      else if (segment.label === "CONTRADICTED") contribution = -1.2;
      else if (segment.label === "MIXED") contribution = 0.25;

      return {
        segmentId: segment.id,
        position: segment.position_index,
        label: segment.label,
        contribution,
        excerpt: segment.text_content
          .replace(/<!--[\s\S]*?-->/g, "")
          .trim()
          .slice(0, 180),
      };
    });

    const topPositive = segmentContributions
      .filter((entry) => entry.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3);

    const topNegative = segmentContributions
      .filter((entry) => entry.contribution < 0)
      .sort((a, b) => a.contribution - b.contribution)
      .slice(0, 3);

    // Low-sample detection (split per backend logic in scoring-math.ts)
    // Integrity: checkable (S+C+M+Unknown) < 3
    const integrityLowSample = checkableSegments < 3;
    // Factuality: V (S+C+M, directionally-verified) < 3
    const factualityLowSample = coveredSegments < 3;

    // Claim-level grounding
    const supportedClaims = allClaims.filter((c) => c.veracity_label === "SUPPORTED").length;
    const contradictedClaims = allClaims.filter((c) => c.veracity_label === "CONTRADICTED").length;
    const mixedClaims = allClaims.filter((c) => c.veracity_label === "MIXED").length;
    const claimGrounding =
      allClaims.length > 0
        ? (supportedClaims + contradictedClaims + mixedClaims) / allClaims.length
        : null;

    return {
      totalSegments,
      unknownRate,
      contradictionRate,
      coveredSegments,
      avgConfidence,
      confidenceBand,
      hasInsufficientEvidenceRisk,
      topPositive,
      topNegative,
      integrityLowSample,
      factualityLowSample,
      claimGrounding,
      totalClaims: allClaims.length,
      resolvedClaims: supportedClaims + contradictedClaims + mixedClaims,
    };
  }, [segments, claims]);

  const copyAllContent = useCallback(() => {
    if (!doc) return;
    const pub = doc.feeds?.publisher_name ?? "Unknown";
    const json = {
      document: {
        id: doc.id,
        title: doc.title,
        url: doc.url,
        publisher: pub,
        author: doc.author,
        published_at: doc.published_at,
        pipeline_status: doc.pipeline_status,
        word_count: doc.word_count,
      },
      scores: {
        segment_grounding:
          doc.grounding_score !== null ? Math.round(doc.grounding_score * 100) : null,
        claim_grounding:
          articleInsights.claimGrounding !== null
            ? Math.round(articleInsights.claimGrounding * 100)
            : null,
        integrity: {
          value: doc.integrity_score !== null ? Math.round(doc.integrity_score * 100) : null,
          status: articleInsights.integrityLowSample ? "low_sample" : "ok",
          checkable: articleInsights.totalSegments,
        },
        factuality: {
          value: doc.factuality_score !== null ? Math.round(doc.factuality_score * 100) : null,
          status: articleInsights.factualityLowSample ? "low_sample" : "ok",
        },
        sourcing_quality:
          doc.sourcing_quality !== null ? Math.round(doc.sourcing_quality * 100) : null,
        editorialization: doc.one_sidedness !== null ? Math.round(doc.one_sidedness * 100) : null,
        sentiment: {
          compound: doc.sentiment_compound,
          positive: doc.sentiment_pos,
          negative: doc.sentiment_neg,
          neutral: doc.sentiment_neu,
        },
        ideology: doc.ideology_scores ?? null,
      },
      insights: {
        segment_evidence_coverage: `${articleInsights.coveredSegments}/${articleInsights.totalSegments}`,
        claim_evidence_coverage: `${articleInsights.resolvedClaims}/${articleInsights.totalClaims}`,
        contradiction_rate: Math.round(articleInsights.contradictionRate * 100),
        unknown_rate: Math.round(articleInsights.unknownRate * 100),
        avg_confidence:
          articleInsights.avgConfidence !== null
            ? Math.round(articleInsights.avgConfidence * 100)
            : null,
        confidence_band: articleInsights.confidenceBand,
      },
      editorial_insight: doc.synthesis_text
        ? {
            text: doc.synthesis_text,
            sources: Array.isArray(doc.synthesis_sources) ? doc.synthesis_sources : [],
          }
        : null,
      strip: doc.strip ?? [],
      segments: (segments ?? []).map((seg) => {
        const segClaims = claims?.filter((c) => c.segment_id === seg.id) ?? [];
        return {
          position: seg.position_index,
          label: seg.label,
          label_name: seg.label ? STRIP_LABEL_NAMES[seg.label] : null,
          classification: seg.classification,
          token_count: seg.token_count,
          text: seg.text_content.replace(/<!--[\s\S]*?-->/g, "").trim(),
          sentiment: {
            compound: seg.sentiment_compound,
            positive: seg.sentiment_pos,
            negative: seg.sentiment_neg,
            neutral: seg.sentiment_neu,
          },
          claims: segClaims.map((claim) => {
            const claimEv = evidence?.filter((e) => e.claim_id === claim.id) ?? [];
            return {
              claim_text: claim.claim_text,
              veracity_label: claim.veracity_label,
              confidence: claim.confidence_score,
              risk_level: claim.risk_level,
              gap_reason: claim.gap_reason,
              conflict_basis: claim.conflict_basis,
              sire: {
                scope: claim.sire_scope,
                information: claim.sire_information,
                retrieval: claim.sire_retrieval,
                exclusions: claim.sire_exclusions,
              },
              evidence: claimEv.map((ev) => ({
                tier: ev.source_tier,
                tier_name: TIER_NAMES[ev.source_tier as EvidenceTier],
                nli_label: ev.nli_label,
                nli_confidence: ev.nli_confidence,
                similarity_score: ev.similarity_score,
                is_independent: ev.is_independent,
                source_publisher: ev.source_publisher,
                source_url: ev.source_url,
                text: ev.evidence_text,
              })),
            };
          }),
        };
      }),
      related_articles: (relatedDocs ?? []).map((rd) => ({
        id: rd.id,
        title: rd.title,
        publisher: rd.feeds?.publisher_name,
        published_at: rd.published_at,
      })),
      provenance: {
        normalizer: "gemini-2.0-flash-lite",
        embeddings: "text-embedding-3-small",
        classification: "perplexity/sonar",
        extraction: "perplexity/sonar",
        veracity: "perplexity/sonar",
        sentiment: "gemini-2.5-flash-lite",
        synthesis: doc.synthesis_text ? "perplexity/sonar" : null,
        ideology: "proposition-irt-v1",
      },
      exported_at: new Date().toISOString(),
    };
    navigator.clipboard.writeText(JSON.stringify(json, null, 2)).then(() => {
      setCopied(true);
      toast.success("Full analysis JSON copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    });
  }, [doc, segments, claims, evidence, relatedDocs, articleInsights]);

  const handleStripCellClick = useCallback((segmentId: string) => {
    setActiveTab("segments");
    setExpandedSegment(segmentId);
    setHighlightedSegment(segmentId);
  }, []);

  useEffect(() => {
    if (!highlightedSegment || activeTab !== "segments") return;

    const element = document.getElementById(`segment-${highlightedSegment}`);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    const timeout = window.setTimeout(() => {
      setHighlightedSegment(null);
    }, 2200);

    return () => window.clearTimeout(timeout);
  }, [highlightedSegment, activeTab]);

  if (!doc) {
    return (
      <AppLayout>
        <div className="container py-6 px-4 sm:px-6">
          <div className="h-96 flex items-center justify-center text-muted-foreground">
            Loading...
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <SEOHead
        title={doc.title ?? "Document Analysis"}
        description={
          doc.synthesis_text
            ? doc.synthesis_text.slice(0, 160).replace(/\n/g, " ")
            : `Integrity analysis of "${doc.title}" by ${publisherName}`
        }
        path={`/document/${id}`}
        ogType="article"
        jsonLd={newsArticleSchema({
          title: doc.title ?? "Untitled",
          description: doc.synthesis_text?.slice(0, 200) ?? "",
          url: `${BASE_URL}/document/${id}`,
          publisherName,
          publishedAt: doc.published_at,
          updatedAt: doc.updated_at,
        })}
      />
      <div
        ref={contentRef}
        className="container py-5 sm:py-8 space-y-5 sm:space-y-8 max-w-4xl px-4 sm:px-6"
      >
        {/* Back + Copy */}
        <div className="flex items-center justify-between">
          <Link
            to="/feed"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Back to Feed
          </Link>
          <button
            type="button"
            onClick={copyAllContent}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2.5 py-1.5 rounded-md border border-transparent hover:border-border hover:bg-muted/50"
            title="Copy full analysis to clipboard"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-strip-supported" />
            ) : (
              <ClipboardCopy className="h-3.5 w-3.5" />
            )}
            <span className="font-mono">{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>

        {/* Header */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4">
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-semibold leading-snug">
                {doc.title ?? "Untitled"}
              </h1>
              <div className="flex items-center gap-2.5 mt-2.5 flex-wrap">
                <Link
                  to={`/publisher/${publisherName}`}
                  className="text-sm font-mono font-medium text-primary hover:underline"
                >
                  {publisherName}
                </Link>
                {doc.published_at && (
                  <span className="text-xs sm:text-sm text-muted-foreground">
                    {formatDistanceToNow(new Date(doc.published_at), { addSuffix: true })}
                  </span>
                )}
              </div>
            </div>
            <PipelineStatusBadge status={doc.pipeline_status} className="shrink-0 self-start" />
          </div>

          {/* Strip + scores */}
          <StripBar
            cells={doc.strip ?? []}
            className="h-5 sm:h-6"
            onCellClick={(segId) => handleStripCellClick(segId)}
          />
          <p className="text-[11px] font-mono text-muted-foreground">
            Click any strip cell to jump directly to its claims and evidence.
          </p>
          <div className="flex items-center gap-4 sm:gap-5 flex-wrap">
            <ScoreBadge label="Grounding" score={doc.grounding_score} />
            <ScoreBadge
              label="Integrity"
              score={doc.integrity_score}
              status={articleInsights.integrityLowSample ? "low_sample" : "ok"}
            />
            <ScoreBadge
              label="Factuality"
              score={doc.factuality_score}
              status={articleInsights.factualityLowSample ? "low_sample" : "ok"}
            />
            <SentimentBadge
              compound={doc.sentiment_compound}
              pos={doc.sentiment_pos}
              neg={doc.sentiment_neg}
              neu={doc.sentiment_neu}
            />
          </div>
          <div className="flex items-center gap-4 sm:gap-5 flex-wrap">
            <ScoreBadge
              label="Claim Grounding"
              score={articleInsights.claimGrounding}
              description={`${articleInsights.resolvedClaims}/${articleInsights.totalClaims} claims resolved to supported, disputed, or mixed verdicts.`}
            />
            <ScoreBadge label="Sourcing Quality" score={doc.sourcing_quality} />
            <ScoreBadge label="Editorialization" score={doc.one_sidedness} />
            <IdeologyBadge scores={doc.ideology_scores} />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] h-5",
                articleInsights.unknownRate >= 0.35
                  ? "border-strip-unknown/50 text-strip-unknown"
                  : "border-muted-foreground/30",
              )}
            >
              Unknown rate {Math.round(articleInsights.unknownRate * 100)}%
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] h-5",
                articleInsights.avgConfidence !== null && articleInsights.avgConfidence < 0.55
                  ? "border-strip-mixed/50 text-strip-mixed"
                  : "border-muted-foreground/30",
              )}
            >
              {articleInsights.confidenceBand}
              {articleInsights.avgConfidence !== null
                ? ` (${Math.round(articleInsights.avgConfidence * 100)}%)`
                : ""}
            </Badge>
            {articleInsights.hasInsufficientEvidenceRisk && (
              <Badge
                variant="outline"
                className="text-[10px] h-5 border-strip-unknown/50 text-strip-unknown bg-strip-unknown/10"
              >
                Insufficient high-tier evidence present
              </Badge>
            )}
          </div>

          <Card className="border-dashed">
            <CardContent className="p-4 sm:p-5 space-y-3">
              <h2 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Why this score?
              </h2>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                <div className="rounded-md border p-2">
                  <span className="text-muted-foreground block">Segment coverage</span>
                  <span className="font-mono text-foreground">
                    {articleInsights.coveredSegments}/{articleInsights.totalSegments || 0}
                  </span>
                </div>
                <div className="rounded-md border p-2">
                  <span className="text-muted-foreground block">Claim coverage</span>
                  <span className="font-mono text-foreground">
                    {articleInsights.resolvedClaims}/{articleInsights.totalClaims}
                  </span>
                </div>
                <div className="rounded-md border p-2">
                  <span className="text-muted-foreground block">Contradicted</span>
                  <span className="font-mono text-foreground">
                    {Math.round(articleInsights.contradictionRate * 100)}%
                  </span>
                </div>
                <div className="rounded-md border p-2">
                  <span className="text-muted-foreground block">Unknown</span>
                  <span className="font-mono text-foreground">
                    {Math.round(articleInsights.unknownRate * 100)}%
                  </span>
                </div>
                <div className="rounded-md border p-2">
                  <span className="text-muted-foreground block">Claim confidence</span>
                  <span className="font-mono text-foreground">
                    {articleInsights.avgConfidence !== null
                      ? `${Math.round(articleInsights.avgConfidence * 100)}%`
                      : "—"}
                  </span>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <h3 className="text-[10px] font-mono uppercase tracking-wider text-strip-supported">
                    Top positive contributors
                  </h3>
                  {articleInsights.topPositive.length > 0 ? (
                    articleInsights.topPositive.map((entry) => (
                      <button
                        type="button"
                        key={entry.segmentId}
                        onClick={() => handleStripCellClick(entry.segmentId)}
                        className="w-full text-left rounded border p-2 hover:bg-muted/40 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-mono text-muted-foreground">
                            Segment {entry.position + 1}
                          </span>
                          <span className="text-[11px] font-mono text-strip-supported">
                            +{entry.contribution.toFixed(2)}
                          </span>
                        </div>
                        <p className="text-xs text-foreground line-clamp-2 mt-1">{entry.excerpt}</p>
                      </button>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No strong positive contributors yet.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <h3 className="text-[10px] font-mono uppercase tracking-wider text-strip-contradicted">
                    Top negative contributors
                  </h3>
                  {articleInsights.topNegative.length > 0 ? (
                    articleInsights.topNegative.map((entry) => (
                      <button
                        type="button"
                        key={entry.segmentId}
                        onClick={() => handleStripCellClick(entry.segmentId)}
                        className="w-full text-left rounded border p-2 hover:bg-muted/40 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-mono text-muted-foreground">
                            Segment {entry.position + 1}
                          </span>
                          <span className="text-[11px] font-mono text-strip-contradicted">
                            {entry.contribution.toFixed(2)}
                          </span>
                        </div>
                        <p className="text-xs text-foreground line-clamp-2 mt-1">{entry.excerpt}</p>
                      </button>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No strong negative contributors yet.
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Editorial Insight */}
          {doc.synthesis_text &&
            (() => {
              const synthSources: string[] = Array.isArray(doc.synthesis_sources)
                ? doc.synthesis_sources
                : [];

              // Extract which citation numbers the model actually used in the text
              const usedNums = new Set<number>();
              const markerRe = /\[(\d+)\]/g;
              for (const m of doc.synthesis_text.matchAll(markerRe)) {
                usedNums.add(Number.parseInt(m[1], 10));
              }

              // Strip [n] markers from display text — we'll show sources separately
              const displayText = doc.synthesis_text.replace(/\[(\d+)\]/g, "");

              // Build source list: map model citation numbers (1-indexed) to source URLs (0-indexed)
              // If no markers found, show all sources
              const sourceEntries: { num: number; url: string }[] = [];
              if (synthSources.length > 0) {
                if (usedNums.size > 0) {
                  for (const num of [...usedNums].sort((a, b) => a - b)) {
                    const url = synthSources[num - 1]; // Sonar citations are 1-indexed
                    if (url) sourceEntries.push({ num, url });
                  }
                  // Also include any sources not referenced by markers
                  synthSources.forEach((url, idx) => {
                    if (!usedNums.has(idx + 1) && !sourceEntries.some((e) => e.url === url)) {
                      sourceEntries.push({ num: idx + 1, url });
                    }
                  });
                } else {
                  synthSources.forEach((url, idx) => sourceEntries.push({ num: idx + 1, url }));
                }
              }

              return (
                <Card className="border-primary/20 bg-primary/5">
                  <CardContent className="p-4 sm:p-5 space-y-2.5">
                    <h2 className="text-xs font-mono text-primary uppercase tracking-wider">
                      Editorial Insight
                    </h2>
                    <div className="prose prose-sm max-w-none text-sm sm:text-base leading-relaxed text-foreground [&_a]:text-primary [&_a]:underline">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                        {displayText}
                      </ReactMarkdown>
                    </div>
                    {sourceEntries.length > 0 && (
                      <div className="pt-2 border-t border-primary/10">
                        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                          Sources
                        </span>
                        <ol className="mt-1.5 space-y-1 list-none">
                          {sourceEntries.map(({ num, url }) => (
                            <li key={num} className="flex items-baseline gap-1.5">
                              <span className="text-[10px] font-mono text-primary/70 shrink-0">
                                [{num}]
                              </span>
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs sm:text-sm text-primary hover:underline font-mono truncate"
                              >
                                {url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}
                              </a>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

          {/* How to Read Results */}
          <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3 text-xs sm:text-sm text-muted-foreground leading-relaxed">
            <span className="font-mono font-semibold text-foreground uppercase tracking-wider text-[10px]">
              How to read these results
            </span>
            <p className="mt-1.5">
              Scores reflect alignment between extracted claims and retrieved evidence at analysis
              time — they are statistical signals, not editorial or legal determinations.{" "}
              <Link to="/methodology" className="text-primary hover:underline font-medium">
                Read the full methodology →
              </Link>
            </p>
          </div>
        </div>

        {/* Source Tier Distribution */}
        {(() => {
          const TIER_BG: Record<string, string> = {
            T1: "bg-tier-t1",
            T2: "bg-tier-t2",
            T3: "bg-tier-t3",
            T4: "bg-tier-t4",
            T5: "bg-tier-t5",
          };
          const tierCounts: Record<string, number> = {};
          let tierTotal = 0;
          if (evidence?.length) {
            for (const ev of evidence) {
              tierCounts[ev.source_tier] = (tierCounts[ev.source_tier] || 0) + 1;
              tierTotal++;
            }
          }
          const tierEntries = (["T1", "T2", "T3", "T4", "T5"] as const)
            .filter((t) => tierCounts[t] > 0)
            .map((t) => ({
              tier: t,
              count: tierCounts[t],
              pct: Math.round((tierCounts[t] / tierTotal) * 100),
            }));

          if (tierEntries.length === 0) return null;

          return (
            <Card className="border-dashed">
              <CardContent className="p-4 sm:p-5 space-y-3">
                <h2 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                  Evidence Source Tiers
                </h2>
                <div className="flex h-3 rounded-full overflow-hidden">
                  {tierEntries.map(({ tier, pct }) => (
                    <Tooltip key={tier}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn("transition-all", TIER_BG[tier])}
                          style={{ width: `${pct}%` }}
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        <span className="text-xs font-mono">
                          {TIER_NAMES[tier as EvidenceTier]}: {tierCounts[tier]} ({pct}%)
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-muted-foreground">
                  {tierEntries.map(({ tier, count, pct }) => (
                    <div key={tier} className="flex items-center gap-1.5">
                      <div className={cn("h-2 w-2 rounded-sm", TIER_BG[tier])} />
                      <span>{TIER_NAMES[tier as EvidenceTier]}</span>
                      <span className="text-foreground font-semibold">{count}</span>
                      <span>({pct}%)</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })()}

        {/* Tabbed content view */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="grid w-full grid-cols-2 h-9">
            <TabsTrigger value="segments" className="text-sm">
              Segments {segments?.length ? `(${segments.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="raw" className="text-sm">
              Raw
            </TabsTrigger>
          </TabsList>

          {/* SEGMENTS TAB — merged chunks + indexed */}
          <TabsContent value="segments" className="space-y-2.5">
            {segments && segments.length > 0 ? (
              segments.map((seg, idx) => {
                const segClaims = getClaimsForSegment(seg.id);
                const isExpanded = expandedSegment === seg.id;
                const hasClaims = segClaims.length > 0;
                const segFootnotes = getFootnotesForSegment(seg.id);

                return (
                  <Collapsible
                    key={seg.id}
                    open={isExpanded}
                    onOpenChange={(o) => setExpandedSegment(o ? seg.id : null)}
                  >
                    <CollapsibleTrigger asChild>
                      <Card
                        id={`segment-${seg.id}`}
                        className={cn(
                          "transition-all hover:shadow-sm",
                          hasClaims && "cursor-pointer",
                          isExpanded && "ring-1 ring-primary/30",
                          highlightedSegment === seg.id && "ring-2 ring-primary/60",
                        )}
                      >
                        <CardContent className="p-3 sm:p-4">
                          <div className="flex items-start gap-2.5 sm:gap-3">
                            <div className="flex flex-col items-center gap-1 shrink-0">
                              <span className="text-[10px] font-mono text-muted-foreground">
                                #{idx}
                              </span>
                              <div
                                className={cn(
                                  "h-3.5 w-3.5 rounded-sm",
                                  seg.label ? STRIP_COLORS[seg.label] : "bg-muted",
                                )}
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p
                                className={cn(
                                  "text-sm sm:text-base leading-relaxed",
                                  isExpanded ? "" : "line-clamp-3",
                                )}
                              >
                                {seg.text_content.replace(/<!--[\s\S]*?-->/g, "").trim()}
                                {segFootnotes.length > 0 && (
                                  <span className="ml-1 text-[10px] font-mono text-primary/70 align-super">
                                    [{segFootnotes.join(",")}]
                                  </span>
                                )}
                              </p>
                              <div className="flex items-center gap-2 mt-2 flex-wrap">
                                <span className="text-[10px] font-mono text-muted-foreground">
                                  {seg.token_count} tokens
                                </span>
                                {seg.label && (
                                  <Badge variant="outline" className="text-[10px] h-5">
                                    {STRIP_LABEL_NAMES[seg.label]}
                                  </Badge>
                                )}
                                {seg.classification && (
                                  <Badge variant="outline" className="text-[10px] h-5">
                                    {seg.classification}
                                  </Badge>
                                )}
                                {hasClaims && (
                                  <span className="text-xs sm:text-sm text-muted-foreground">
                                    {segClaims.length} claim{segClaims.length !== 1 ? "s" : ""}
                                  </span>
                                )}
                                <SentimentBadge
                                  compound={seg.sentiment_compound}
                                  pos={seg.sentiment_pos}
                                  neg={seg.sentiment_neg}
                                  neu={seg.sentiment_neu}
                                />
                                <span className="text-[10px] font-mono text-primary/60">
                                  ⬡ embedded
                                </span>
                              </div>
                              {hasClaims && <SegmentScoreBar claims={segClaims} />}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      {hasClaims && (
                        <div className="ml-5 sm:ml-7 mt-1.5 space-y-2.5">
                          {segClaims.map((claim) => {
                            const claimEvidence = getEvidenceForClaim(claim.id);
                            return (
                              <Card key={claim.id} className="border-dashed">
                                <CardContent className="p-3 sm:p-4 space-y-2.5">
                                  <p className="text-sm sm:text-base font-medium">
                                    {claim.claim_text}
                                  </p>
                                  <div className="flex items-center gap-2.5 flex-wrap">
                                    {claim.veracity_label && (
                                      <VeracityBadge label={claim.veracity_label} />
                                    )}
                                    {claim.confidence_score !== null && (
                                      <span className="text-xs sm:text-sm font-mono text-muted-foreground">
                                        {Math.round(claim.confidence_score * 100)}% conf
                                      </span>
                                    )}
                                    {claim.risk_level && claim.risk_level !== "LOW" && (
                                      <Badge
                                        variant="outline"
                                        className={cn(
                                          "text-[10px] h-5 border",
                                          claim.risk_level === "CRITICAL" &&
                                            "border-destructive/50 text-destructive bg-destructive/10",
                                          claim.risk_level === "HIGH" &&
                                            "border-strip-contradicted/50 text-strip-contradicted bg-strip-contradicted/10",
                                          claim.risk_level === "MEDIUM" &&
                                            "border-strip-mixed/50 text-strip-mixed bg-strip-mixed/10",
                                        )}
                                      >
                                        {RISK_LEVEL_NAMES[claim.risk_level as RiskLevel]} Risk
                                      </Badge>
                                    )}
                                  </div>
                                  {/* High-risk claim warning */}
                                  {claim.risk_level &&
                                    ["CRITICAL", "HIGH"].includes(claim.risk_level) &&
                                    claim.gap_reason === "INSUFFICIENT_TIER_FOR_RISK" && (
                                      <div className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-1.5 rounded bg-strip-unknown/10 border border-strip-unknown/20 text-strip-unknown">
                                        <span>⚡</span>
                                        <span>High-risk claim — awaiting higher-tier evidence</span>
                                      </div>
                                    )}
                                  {claim.gap_reason && (
                                    <p className="text-xs font-mono text-muted-foreground italic">
                                      ⚠{" "}
                                      {GAP_REASON_NAMES[claim.gap_reason as GapReason] ||
                                        claim.gap_reason}
                                    </p>
                                  )}
                                  {claim.conflict_basis && (
                                    <p className="text-xs text-strip-mixed/80 italic">
                                      ↔ {claim.conflict_basis}
                                    </p>
                                  )}
                                  {claimEvidence.length > 0 && (
                                    <div className="space-y-1.5 pt-2 border-t">
                                      <span className="text-xs font-mono text-muted-foreground uppercase">
                                        Evidence ({claimEvidence.length}){(() => {
                                          const indep = claimEvidence.filter(
                                            (e) => e.is_independent,
                                          ).length;
                                          const nonIndep = claimEvidence.length - indep;
                                          return nonIndep > 0 ? (
                                            <span className="ml-1.5 text-[10px] text-muted-foreground/70 normal-case">
                                              · {indep} independent · {nonIndep} echo
                                            </span>
                                          ) : null;
                                        })()}
                                      </span>
                                      {claimEvidence.map((ev) => (
                                        <div
                                          key={ev.id}
                                          className={cn(
                                            "text-xs sm:text-sm p-2.5 rounded",
                                            !ev.is_independent
                                              ? "bg-muted/30 border border-dashed border-muted-foreground/20"
                                              : "bg-muted/50",
                                          )}
                                        >
                                          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                            <Badge
                                              variant="outline"
                                              className="text-[10px] sm:text-xs h-5"
                                            >
                                              {TIER_NAMES[ev.source_tier]}
                                            </Badge>
                                            {ev.nli_label && (
                                              <Badge
                                                variant="outline"
                                                className={cn(
                                                  "text-[10px] sm:text-xs h-5",
                                                  ev.nli_label === "ENTAILMENT" &&
                                                    "border-strip-supported/50 text-strip-supported",
                                                  ev.nli_label === "CONTRADICTION" &&
                                                    "border-strip-contradicted/50 text-strip-contradicted",
                                                  ev.nli_label === "NEUTRAL" &&
                                                    "border-strip-unknown/50 text-strip-unknown",
                                                )}
                                              >
                                                {ev.nli_label}
                                              </Badge>
                                            )}
                                            {!ev.is_independent && (
                                              <Badge
                                                variant="outline"
                                                className="text-[10px] h-5 border-muted-foreground/30 text-muted-foreground"
                                              >
                                                Non-independent
                                              </Badge>
                                            )}
                                            {ev.similarity_score !== null && (
                                              <span className="font-mono text-muted-foreground">
                                                {Math.round(ev.similarity_score * 100)}% sim
                                              </span>
                                            )}
                                            {ev.source_publisher && (
                                              <span className="text-muted-foreground italic">
                                                {ev.source_publisher}
                                              </span>
                                            )}
                                          </div>
                                          <p className="text-muted-foreground line-clamp-3">
                                            {ev.evidence_text}
                                          </p>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </CardContent>
                              </Card>
                            );
                          })}
                        </div>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                );
              })
            ) : (
              <Card>
                <CardContent className="p-5 sm:p-6">
                  <p className="text-sm sm:text-base text-muted-foreground text-center">
                    No segments yet. Document needs indexing.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* RAW TAB */}
          <TabsContent value="raw" className="space-y-3">
            {doc.normalized_content ? (
              <Card>
                <CardContent className="p-5 sm:p-6">
                  <h2 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">
                    Normalized Content
                  </h2>
                  <div className="prose prose-sm sm:prose max-w-none dark:prose-invert text-foreground">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                      {doc.normalized_content}
                    </ReactMarkdown>
                  </div>
                </CardContent>
              </Card>
            ) : null}
            {doc.raw_content ? (
              <Card>
                <CardContent className="p-5 sm:p-6">
                  <h2 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">
                    Raw RSS Content
                  </h2>
                  <p className="text-sm sm:text-base leading-relaxed text-muted-foreground whitespace-pre-line">
                    {doc.raw_content
                      .replace(/<[^>]+>/g, " ")
                      .replace(/\s+/g, " ")
                      .trim()}
                  </p>
                </CardContent>
              </Card>
            ) : null}
            {!doc.normalized_content && !doc.raw_content && (
              <Card>
                <CardContent className="p-5 sm:p-6">
                  <p className="text-sm sm:text-base text-muted-foreground text-center">
                    No content available yet. Pipeline status: {doc.pipeline_status}
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>

        {/* Related Articles */}
        {relatedDocs && relatedDocs.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-xs sm:text-sm font-mono font-semibold text-muted-foreground uppercase tracking-wider">
              Related Articles ({relatedDocs.length})
            </h2>
            <p className="text-xs text-muted-foreground">Other articles covering the same story</p>
            <div className="grid gap-2">
              {relatedDocs.map((relDoc) => (
                <ArticleCard key={relDoc.id} document={relDoc} />
              ))}
            </div>
          </div>
        )}

        {/* Provenance */}
        <Card className="border-dashed">
          <CardContent className="p-4 sm:p-5">
            <h2 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-3">
              Analysis Provenance
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs sm:text-sm">
              <div className="space-y-0.5">
                <span className="text-muted-foreground block">Normalizer</span>
                <span className="font-mono text-foreground">gemini-2.0-flash-lite</span>
              </div>
              <div className="space-y-0.5">
                <span className="text-muted-foreground block">Embeddings</span>
                <span className="font-mono text-foreground">text-embedding-3-small</span>
              </div>
              <div className="space-y-0.5">
                <span className="text-muted-foreground block">Classification</span>
                <span className="font-mono text-foreground">perplexity/sonar</span>
              </div>
              <div className="space-y-0.5">
                <span className="text-muted-foreground block">Extraction</span>
                <span className="font-mono text-foreground">perplexity/sonar</span>
              </div>
              <div className="space-y-0.5">
                <span className="text-muted-foreground block">Veracity</span>
                <span className="font-mono text-foreground">perplexity/sonar</span>
              </div>
              <div className="space-y-0.5">
                <span className="text-muted-foreground block">Sentiment</span>
                <span className="font-mono text-foreground">gemini-2.5-flash-lite</span>
              </div>
              {doc.synthesis_text && (
                <div className="space-y-0.5">
                  <span className="text-muted-foreground block">Synthesis</span>
                  <span className="font-mono text-foreground">perplexity/sonar</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
