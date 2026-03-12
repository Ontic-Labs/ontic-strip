import { AppLayout } from "@/components/layout/AppLayout";
import { ScoreBadge } from "@/components/strip/ScoreBadge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { BASE_URL, SEOHead, collectionPageSchema } from "@/lib/seo";
import type { PublisherBaseline } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../i18n";

type Period = "7d" | "30d";
type SortKey = "integrity" | "grounding" | "factuality" | "articles";
const LEADERBOARD_PER_PAGE = 20;

export default function Leaderboard() {
  const { t, i18n } = useTranslation("pages");
  const locale = i18n.language;
  const { t: tUI } = useTranslation("ui");
  const { t: tStrip } = useTranslation("strip");
  const [period, setPeriod] = useState<Period>("7d");
  const [sortBy, setSortBy] = useState<SortKey>("integrity");
  const [page, setPage] = useState(1);

  const { data: baselines, isLoading } = useQuery({
    queryKey: ["publisher_baselines"],
    queryFn: async () => {
      const { data, error } = await supabase.from("publisher_baselines").select("*");
      if (error) throw error;
      return data as unknown as PublisherBaseline[];
    },
  });

  const { data: feeds } = useQuery({
    queryKey: ["feeds", locale],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feeds")
        .select("publisher_name, source_category")
        .eq("locale", locale);
      if (error) throw error;
      return data as { publisher_name: string; source_category: string }[];
    },
  });

  const localePublishers = useMemo(
    () => new Set(feeds?.map((f) => f.publisher_name) ?? []),
    [feeds],
  );

  const categoryMap = new Map(feeds?.map((f) => [f.publisher_name, f.source_category]) ?? []);

  const filtered =
    baselines
      ?.filter((b) => b.period === period)
      .filter((b) => localePublishers.size === 0 || localePublishers.has(b.publisher_name))
      .sort((a, b) => {
        if (sortBy === "integrity")
          return (b.avg_integrity_score ?? 0) - (a.avg_integrity_score ?? 0);
        if (sortBy === "grounding")
          return (b.avg_grounding_score ?? 0) - (a.avg_grounding_score ?? 0);
        if (sortBy === "factuality")
          return (b.avg_factuality_score ?? 0) - (a.avg_factuality_score ?? 0);
        return b.document_count - a.document_count;
      }) ?? [];

  const totalRows = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / LEADERBOARD_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const hasMultiplePages = totalPages > 1;
  const pagedFiltered = useMemo(() => {
    const start = (currentPage - 1) * LEADERBOARD_PER_PAGE;
    const end = start + LEADERBOARD_PER_PAGE;
    return filtered.slice(start, end);
  }, [filtered, currentPage]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  return (
    <AppLayout>
      <SEOHead
        title="Publisher Leaderboard"
        description="Publishers ranked by evidence-backed reporting quality, with grounding and integrity scores over 7-day and 30-day periods."
        path="/leaderboard"
        jsonLd={collectionPageSchema({
          name: "Publisher Leaderboard",
          description: "Publishers ranked by reporting quality",
          url: `${BASE_URL}/leaderboard`,
        })}
      />
      <div className="container py-4 sm:py-6 space-y-4 sm:space-y-6 px-4 sm:px-6 max-w-3xl">
        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">
            {t("leaderboard.title")}
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">{t("leaderboard.description")}</p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-md border text-xs font-mono">
            {(["7d", "30d"] as const).map((p) => (
              <button
                type="button"
                key={p}
                onClick={() => {
                  setPeriod(p);
                  setPage(1);
                }}
                className={cn(
                  "px-3 py-1.5 transition-colors",
                  period === p
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="flex rounded-md border text-xs font-mono">
            {(
              [
                ["integrity", t("leaderboard.sortIntegrity")],
                ["grounding", t("leaderboard.sortGrounding")],
                ["factuality", t("leaderboard.sortFactuality")],
                ["articles", t("leaderboard.sortArticles")],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                onClick={() => {
                  setSortBy(key);
                  setPage(1);
                }}
                className={cn(
                  "px-3 py-1.5 transition-colors",
                  sortBy === key
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Link
            to="/compare"
            className="text-xs text-primary hover:underline font-medium font-mono ml-auto"
          >
            {t("leaderboard.comparePublishers")}
          </Link>
        </div>

        {/* Rankings */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center py-12 text-muted-foreground text-sm">
            {t("leaderboard.noData")}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {tUI("pagination.showingRange", {
                  entity: "publishers",
                  start: (currentPage - 1) * LEADERBOARD_PER_PAGE + 1,
                  end: Math.min(currentPage * LEADERBOARD_PER_PAGE, totalRows),
                  total: totalRows,
                })}
              </span>
              {hasMultiplePages && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage <= 1}
                    className="px-2.5 py-1 rounded border text-[11px] font-mono disabled:opacity-50"
                  >
                    {tUI("pagination.previous")}
                  </button>
                  <span className="font-mono text-[11px]">
                    {tUI("pagination.page", { current: currentPage, total: totalPages })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage >= totalPages}
                    className="px-2.5 py-1 rounded border text-[11px] font-mono disabled:opacity-50"
                  >
                    {tUI("pagination.next")}
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-2">
              {pagedFiltered.map((baseline, indexOnPage) => {
                const rank = (currentPage - 1) * LEADERBOARD_PER_PAGE + indexOnPage;
                const category = categoryMap.get(baseline.publisher_name) ?? "mainstream";
                return (
                  <Link
                    key={baseline.id}
                    to={`/publisher/${encodeURIComponent(baseline.publisher_name)}`}
                  >
                    <Card className="hover:shadow-md transition-all hover:border-primary/20">
                      <CardContent className="p-3 sm:p-4 flex items-center gap-3 sm:gap-4">
                        {/* Rank */}
                        <div
                          className={cn(
                            "w-8 h-8 rounded-full flex items-center justify-center text-xs font-mono font-bold shrink-0",
                            rank === 0 && "bg-strip-supported/20 text-strip-supported",
                            rank === 1 && "bg-primary/10 text-primary",
                            rank === 2 && "bg-strip-mixed/10 text-strip-mixed",
                            rank > 2 && "bg-muted text-muted-foreground",
                          )}
                        >
                          {rank + 1}
                        </div>

                        {/* Name + category */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-xs sm:text-sm truncate">
                              {baseline.publisher_name}
                            </span>
                            <span
                              className={cn(
                                "text-[9px] sm:text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0",
                                category === "mainstream" && "bg-primary/10 text-primary",
                                category === "partisan" && "bg-strip-mixed/10 text-strip-mixed",
                                category === "fringe" &&
                                  "bg-strip-contradicted/10 text-strip-contradicted",
                                category === "reference" &&
                                  "bg-strip-supported/10 text-strip-supported",
                              )}
                            >
                              {tUI(`categories.${category}`)}
                            </span>
                          </div>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {tUI("units.article", { count: baseline.document_count })}
                          </span>
                        </div>

                        <div className="flex items-center gap-3 sm:gap-4 shrink-0 flex-wrap justify-end">
                          <ScoreBadge
                            label="G"
                            labelKey="grounding"
                            score={baseline.avg_grounding_score}
                          />
                          <ScoreBadge
                            label="I"
                            labelKey="integrity"
                            score={baseline.avg_integrity_score}
                          />
                          <ScoreBadge
                            label="F"
                            labelKey="factuality"
                            score={baseline.avg_factuality_score}
                          />
                          {baseline.avg_ideology_economic != null && (
                            <div className="flex items-center gap-1 text-xs">
                              <span className="text-muted-foreground text-[10px]">
                                {t("leaderboard.ideo")}
                              </span>
                              <span className="font-mono text-muted-foreground text-[10px]">
                                {baseline.avg_ideology_economic > 0 ? "+" : ""}
                                {baseline.avg_ideology_economic.toFixed(1)}/
                                {baseline.avg_ideology_social != null
                                  ? (baseline.avg_ideology_social > 0 ? "+" : "") +
                                    baseline.avg_ideology_social.toFixed(1)
                                  : "—"}
                              </span>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>

            {hasMultiplePages && (
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  className="px-2.5 py-1 rounded border text-[11px] font-mono disabled:opacity-50"
                >
                  {tUI("pagination.previous")}
                </button>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {tUI("pagination.page", { current: currentPage, total: totalPages })}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                  className="px-2.5 py-1 rounded border text-[11px] font-mono disabled:opacity-50"
                >
                  {tUI("pagination.next")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
