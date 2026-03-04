import { AppLayout } from "@/components/layout/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { SEOHead } from "@/lib/seo";
import type { RiskLevel, VeracityLabel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
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

const RISK_STYLES: Record<RiskLevel, string> = {
  LOW: "text-muted-foreground",
  MEDIUM: "text-strip-unknown",
  HIGH: "text-strip-mixed",
  CRITICAL: "text-strip-contradicted",
};

interface ClaimResult {
  id: string;
  claim_text: string;
  veracity_label: VeracityLabel | null;
  risk_level: RiskLevel | null;
  document_id: string;
  documents: { title: string | null; feeds: { publisher_name: string } | null } | null;
}

const CLAIMS_PER_PAGE = 20;

export default function ClaimSearch() {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const deferredQuery = useDeferredValue(query);

  const { data: claims, isLoading } = useQuery({
    queryKey: ["claim-search", deferredQuery],
    queryFn: async () => {
      if (!deferredQuery || deferredQuery.length < 3) return [];

      const { data, error } = await supabase
        .from("claims")
        .select(
          "id, claim_text, veracity_label, risk_level, document_id, documents(title, feeds(publisher_name))",
        )
        .ilike("claim_text", `%${deferredQuery}%`)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return (data ?? []) as unknown as ClaimResult[];
    },
    enabled: deferredQuery.length >= 3,
  });

  const veracityCounts =
    claims?.reduce<Record<string, number>>((acc, c) => {
      const label = c.veracity_label ?? "UNKNOWN";
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {}) ?? {};

  const totalClaims = claims?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalClaims / CLAIMS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const hasMultiplePages = totalPages > 1;
  const pagedClaims = useMemo(() => {
    const list = claims ?? [];
    const start = (currentPage - 1) * CLAIMS_PER_PAGE;
    const end = start + CLAIMS_PER_PAGE;
    return list.slice(start, end);
  }, [claims, currentPage]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  return (
    <AppLayout>
      <SEOHead
        title="Claim Search"
        description="Search across all extracted claims from analyzed news articles. Find verified, disputed, and mixed claims by keyword."
        path="/search"
      />
      <div className="container py-4 sm:py-6 space-y-4 sm:space-y-6 px-4 sm:px-6 max-w-3xl">
        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">Claim Search</h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Search across all extracted claims from analyzed articles
          </p>
        </div>

        <Input
          placeholder="Search claims (e.g. &quot;inflation rate&quot;, &quot;climate&quot;)..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          className="font-mono"
        />

        {/* Summary stats */}
        {claims && claims.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="font-mono text-muted-foreground">{claims.length} claims found</span>
            {Object.entries(veracityCounts).map(([label, count]) => (
              <Badge
                key={label}
                variant="outline"
                className={cn("text-[10px] font-mono", VERACITY_STYLES[label as VeracityLabel])}
              >
                {VERACITY_NAMES[label as VeracityLabel] ?? label}: {count}
              </Badge>
            ))}
          </div>
        )}

        {/* Results */}
        {deferredQuery.length < 3 ? (
          <p className="text-center py-12 text-muted-foreground text-sm">
            Type at least 3 characters to search.
          </p>
        ) : isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : !claims?.length ? (
          <div className="text-center py-12 space-y-2">
            <div className="text-3xl">⊘</div>
            <p className="text-sm text-muted-foreground">No claims match "{deferredQuery}"</p>
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
                    <CardContent className="p-3 sm:p-4 space-y-2">
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
                        {claim.risk_level && (
                          <span
                            className={cn("text-[10px] font-mono", RISK_STYLES[claim.risk_level])}
                          >
                            {claim.risk_level} risk
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground font-mono ml-auto">
                          {claim.documents?.feeds?.publisher_name ?? "Unknown"} ·{" "}
                          {claim.documents?.title
                            ? claim.documents.title.slice(0, 60) +
                              (claim.documents.title.length > 60 ? "…" : "")
                            : "Untitled"}
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
