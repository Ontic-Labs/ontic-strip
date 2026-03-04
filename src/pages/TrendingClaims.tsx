import { AppLayout } from "@/components/layout/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { BASE_URL, SEOHead, collectionPageSchema } from "@/lib/seo";
import type { GapReason, RiskLevel, VeracityLabel } from "@/lib/types";
import { GAP_REASON_NAMES } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const VERACITY_STYLES: Record<VeracityLabel, string> = {
  SUPPORTED: "border-strip-supported text-strip-supported",
  CONTRADICTED: "border-strip-contradicted text-strip-contradicted",
  MIXED: "border-strip-mixed text-strip-mixed",
  UNKNOWN: "border-strip-unknown text-strip-unknown",
  NOT_CHECKABLE: "border-muted-foreground text-muted-foreground",
};

const VERACITY_NAMES: Record<VeracityLabel, string> = {
  SUPPORTED: "Supported",
  CONTRADICTED: "Disputed",
  MIXED: "Mixed",
  UNKNOWN: "Unknown",
  NOT_CHECKABLE: "Not Checkable",
};

type FilterLabel = "all" | VeracityLabel;
const CLAIMS_PER_PAGE = 20;

interface TrendingClaim {
  id: string;
  claim_text: string;
  veracity_label: VeracityLabel | null;
  risk_level: RiskLevel | null;
  gap_reason: GapReason | null;
  document_id: string;
  created_at: string;
  documents: {
    title: string | null;
    published_at: string | null;
    feeds: { publisher_name: string } | null;
  } | null;
}

export default function TrendingClaims() {
  const [filter, setFilter] = useState<FilterLabel>("all");
  const [page, setPage] = useState(1);

  const { data: claims, isLoading } = useQuery({
    queryKey: ["trending-claims"],
    queryFn: async () => {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data, error } = await supabase
        .from("claims")
        .select(
          "id, claim_text, veracity_label, risk_level, gap_reason, document_id, created_at, documents(title, published_at, feeds(publisher_name))",
        )
        .gte("created_at", weekAgo)
        .not("veracity_label", "is", null)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as TrendingClaim[];
    },
  });

  const filtered = filter === "all" ? claims : claims?.filter((c) => c.veracity_label === filter);
  const totalClaims = filtered?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalClaims / CLAIMS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const hasMultiplePages = totalPages > 1;
  const pagedClaims = useMemo(() => {
    const list = filtered ?? [];
    const start = (currentPage - 1) * CLAIMS_PER_PAGE;
    const end = start + CLAIMS_PER_PAGE;
    return list.slice(start, end);
  }, [filtered, currentPage]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const veracityCounts =
    claims?.reduce<Record<string, number>>((acc, c) => {
      const label = c.veracity_label ?? "UNKNOWN";
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {}) ?? {};

  return (
    <AppLayout>
      <SEOHead
        title="Trending Claims"
        description="The latest verified claims from this week's analyzed articles, filterable by veracity label."
        path="/claims"
        jsonLd={collectionPageSchema({
          name: "Trending Claims",
          description: "Latest verified claims from analyzed articles",
          url: `${BASE_URL}/claims`,
        })}
      />
      <div className="container py-4 sm:py-6 space-y-4 sm:space-y-6 px-4 sm:px-6 max-w-3xl">
        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">
            Trending Claims
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Claims extracted and analyzed from this week's articles
          </p>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => {
              setFilter("all");
              setPage(1);
            }}
            className={cn(
              "px-2.5 py-1 rounded text-xs font-mono transition-colors",
              filter === "all"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent",
            )}
          >
            All {claims?.length ? `(${claims.length})` : ""}
          </button>
          {(["SUPPORTED", "CONTRADICTED", "MIXED", "UNKNOWN"] as VeracityLabel[]).map((label) => (
            <button
              type="button"
              key={label}
              onClick={() => {
                setFilter(label);
                setPage(1);
              }}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-mono transition-colors",
                filter === label
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent",
              )}
            >
              {VERACITY_NAMES[label]} {veracityCounts[label] ? `(${veracityCounts[label]})` : ""}
            </button>
          ))}
        </div>

        {/* Claims */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : !filtered?.length ? (
          <div className="text-center py-12 space-y-2">
            <div className="text-3xl">⊘</div>
            <p className="text-sm text-muted-foreground">
              {filter === "all"
                ? "No claims from this week yet."
                : `No ${VERACITY_NAMES[filter as VeracityLabel].toLowerCase()} claims this week.`}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-muted-foreground">
              <span>
                Showing claims {(currentPage - 1) * CLAIMS_PER_PAGE + 1}-
                {Math.min(currentPage * CLAIMS_PER_PAGE, totalClaims)} of {totalClaims}
              </span>
              {hasMultiplePages && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage <= 1}
                    className="px-2.5 py-1 rounded border text-[11px] font-mono disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="font-mono text-[11px]">
                    Page {currentPage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage >= totalPages}
                    className="px-2.5 py-1 rounded border text-[11px] font-mono disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-2">
              {pagedClaims.map((claim) => (
                <Link key={claim.id} to={`/document/${claim.document_id}`}>
                  <Card className="hover:shadow-md transition-all hover:border-primary/20">
                    <CardContent className="p-3 sm:p-4 space-y-1.5">
                      <p className="text-xs sm:text-sm leading-relaxed">{claim.claim_text}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        {claim.veracity_label && (
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] font-mono",
                              VERACITY_STYLES[claim.veracity_label],
                            )}
                          >
                            {VERACITY_NAMES[claim.veracity_label]}
                          </Badge>
                        )}
                        {claim.risk_level && claim.risk_level !== "LOW" && (
                          <span className="text-[10px] font-mono text-strip-mixed">
                            {claim.risk_level} risk
                          </span>
                        )}
                        {claim.veracity_label === "UNKNOWN" && claim.gap_reason && (
                          <span className="text-[10px] font-mono text-muted-foreground italic">
                            {GAP_REASON_NAMES[claim.gap_reason]}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground font-mono ml-auto truncate max-w-[200px]">
                          {claim.documents?.feeds?.publisher_name ?? "Unknown"}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>

            {hasMultiplePages && (
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  className="px-2.5 py-1 rounded border text-[11px] font-mono disabled:opacity-50"
                >
                  Previous
                </button>
                <span className="font-mono text-[11px] text-muted-foreground">
                  Page {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                  className="px-2.5 py-1 rounded border text-[11px] font-mono disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
