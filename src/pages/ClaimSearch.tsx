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
import { useDeferredValue, useState } from "react";
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

export default function ClaimSearch() {
  const [query, setQuery] = useState("");
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
          onChange={(e) => setQuery(e.target.value)}
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
          <div className="space-y-2">
            {claims.map((claim) => (
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
        )}
      </div>
    </AppLayout>
  );
}
