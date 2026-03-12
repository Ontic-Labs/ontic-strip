import { ArticleCard } from "@/components/feed/ArticleCard";
import { PublisherAnalysisCard } from "@/components/feed/PublisherAnalysisCard";
import { AppLayout } from "@/components/layout/AppLayout";
import { IntegritySparkline } from "@/components/strip/IntegritySparkline";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";

import { ScoreBadge } from "@/components/strip/ScoreBadge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BASE_URL, SEOHead, collectionPageSchema } from "@/lib/seo";
import type { Document, PublisherBaseline } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n";

const CATEGORY_OPTIONS = ["all", "mainstream", "reference", "partisan", "fringe"] as const;
type CategoryFilter = (typeof CATEGORY_OPTIONS)[number];
const PUBLISHERS_PER_PAGE = 12;

export default function FeedView() {
  const { t, i18n } = useTranslation("feed");
  const { t: tUI } = useTranslation("ui");
  const locale = i18n.language;
  const [publisherFilter, setPublisherFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data: documents, isLoading } = useQuery({
    queryKey: ["documents_feed", locale],
    queryFn: async () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data, error } = await supabase
        .from("documents")
        .select("*, feeds!inner(*)")
        .eq("feeds.locale", locale)
        .gte("published_at", sevenDaysAgo)
        .order("published_at", { ascending: false, nullsFirst: false })
        .limit(200);

      if (error) throw error;
      return (data ?? []) as unknown as Document[];
    },
  });

  const { data: baselines } = useQuery({
    queryKey: ["publisher_baselines", locale],
    queryFn: async () => {
      const { data: localeFeeds } = await supabase
        .from("feeds")
        .select("publisher_name")
        .eq("locale", locale)
        .eq("is_active", true);
      const localeNames = new Set((localeFeeds ?? []).map((f) => f.publisher_name));

      const { data, error } = await supabase.from("publisher_baselines").select("*");
      if (error) throw error;
      const all = data as unknown as PublisherBaseline[];
      return localeNames.size > 0 ? all.filter((b) => localeNames.has(b.publisher_name)) : all;
    },
  });

  const filtered = documents?.filter((doc) => {
    const name = doc.feeds?.publisher_name ?? "Unknown";
    if (publisherFilter !== "all" && name !== publisherFilter) return false;
    const category = doc.feeds?.source_category ?? "mainstream";
    if (categoryFilter !== "all" && category !== categoryFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return doc.title?.toLowerCase().includes(q) || name.toLowerCase().includes(q);
  });

  // Unique publisher names for the dropdown
  const publisherNames = useMemo(() => {
    if (!documents) return [];
    const names = new Set(documents.map((d) => d.feeds?.publisher_name ?? "Unknown"));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [documents]);

  const grouped = useMemo(() => {
    if (!filtered) return [];
    const map = new Map<string, { category: string; docs: Document[]; newestAt: number }>();
    for (const doc of filtered) {
      const name = doc.feeds?.publisher_name ?? "Unknown";
      const cat = doc.feeds?.source_category ?? "mainstream";
      if (!map.has(name)) map.set(name, { category: cat, docs: [], newestAt: 0 });
      const entry = map.get(name)!;
      entry.docs.push(doc);
      const ts = doc.published_at ? new Date(doc.published_at).getTime() : 0;
      if (ts > entry.newestAt) entry.newestAt = ts;
    }
    return Array.from(map.entries()).sort(([, a], [, b]) => b.newestAt - a.newestAt);
  }, [filtered]);

  const totalPublisherGroups = grouped.length;
  const totalPages = Math.max(1, Math.ceil(totalPublisherGroups / PUBLISHERS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const hasMultiplePages = totalPages > 1;
  const pagedGrouped = useMemo(() => {
    const start = (currentPage - 1) * PUBLISHERS_PER_PAGE;
    const end = start + PUBLISHERS_PER_PAGE;
    return grouped.slice(start, end);
  }, [grouped, currentPage]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  /** Publishers with at least one article in the last 48h get auto-expanded */
  const freshPublishers = useMemo(() => {
    const cutoff = Date.now() - 48 * 3600000;
    return pagedGrouped.filter(([, { newestAt }]) => newestAt > cutoff).map(([name]) => name);
  }, [pagedGrouped]);

  const getBaselines = (name: string) => baselines?.filter((b) => b.publisher_name === name) ?? [];

  const getQuickScore = (name: string) => {
    const b7 = baselines?.find((b) => b.publisher_name === name && b.period === "7d");
    return b7?.avg_integrity_score ?? null;
  };

  /** Build daily integrity sparkline points per publisher from loaded docs */
  const getSparklinePoints = useMemo(() => {
    if (!documents?.length) return (_name: string) => [];
    const byPublisher = new Map<string, Map<string, number[]>>();
    for (const doc of documents) {
      if (doc.integrity_score == null || !doc.published_at) continue;
      const pub = doc.feeds?.publisher_name ?? "Unknown";
      if (!byPublisher.has(pub)) byPublisher.set(pub, new Map());
      const dayKey = doc.published_at.slice(0, 10);
      const dayMap = byPublisher.get(pub)!;
      if (!dayMap.has(dayKey)) dayMap.set(dayKey, []);
      dayMap.get(dayKey)!.push(doc.integrity_score);
    }
    // Pre-compute sorted daily averages per publisher
    const cache = new Map<string, number[]>();
    for (const [pub, dayMap] of byPublisher) {
      const sorted = Array.from(dayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, scores]) => scores.reduce((a, b) => a + b, 0) / scores.length);
      cache.set(pub, sorted);
    }
    return (name: string) => cache.get(name) ?? [];
  }, [documents]);

  return (
    <AppLayout>
      <SEOHead
        title={t("pageTitle")}
        description={t("pageDescription")}
        path="/feed"
        jsonLd={collectionPageSchema({
          name: "Article Feed",
          description: "Real-time integrity analysis of ingested articles",
          url: `${BASE_URL}/feed`,
        })}
      />
      <div className="container py-4 sm:py-6 space-y-4 sm:space-y-6 px-4 sm:px-6">
        {/* Page header */}
        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">
            {t("pageTitle")}
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">{t("pageDescription")}</p>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
          <Input
            placeholder={t("searchArticles")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full sm:max-w-xs"
          />
          <Select
            value={publisherFilter}
            onValueChange={(value) => {
              setPublisherFilter(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue placeholder={t("allPublishers")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allPublishers")}</SelectItem>
              {publisherNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={categoryFilter}
            onValueChange={(value) => {
              setCategoryFilter(value as CategoryFilter);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-[170px]">
              <SelectValue placeholder={t("allCategories")} />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((category) => (
                <SelectItem key={category} value={category}>
                  {category === "all" ? t("allCategories") : tUI(`categories.${category}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!isLoading && !!filtered?.length && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {tUI("pagination.showingRange", {
                entity: "publishers",
                start: (currentPage - 1) * PUBLISHERS_PER_PAGE + 1,
                end: Math.min(currentPage * PUBLISHERS_PER_PAGE, totalPublisherGroups),
                total: totalPublisherGroups,
              })}
            </span>
            {hasMultiplePages && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                >
                  {tUI("pagination.previous")}
                </Button>
                <span className="font-mono text-[11px]">
                  {tUI("pagination.page", { current: currentPage, total: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                >
                  {tUI("pagination.next")}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Publisher accordion groups */}
        {isLoading ? (
          <div className="grid gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 sm:h-36 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : !filtered?.length ? (
          <div className="text-center py-12 sm:py-20 space-y-3">
            <div className="text-3xl sm:text-4xl">
              {search || publisherFilter !== "all" ? "⊘" : "◉"}
            </div>
            <h2 className="text-base sm:text-lg font-semibold">
              {search || publisherFilter !== "all" ? t("noArticlesFiltered") : t("noArticlesYet")}
            </h2>
            <p className="text-xs sm:text-sm text-muted-foreground">
              {search || publisherFilter !== "all"
                ? t("noArticlesFilteredHint")
                : t("noArticlesYetHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <Accordion
              type="multiple"
              defaultValue={
                freshPublishers.length > 0 ? freshPublishers : pagedGrouped.map(([name]) => name)
              }
              className="space-y-4"
            >
              {pagedGrouped.map(([publisher, { category, docs }]) => {
                const integrityScore = getQuickScore(publisher);
                const pubBaselines = getBaselines(publisher);

                return (
                  <AccordionItem
                    key={publisher}
                    value={publisher}
                    className="border rounded-lg overflow-hidden"
                  >
                    <AccordionTrigger className="px-3 sm:px-4 py-3 hover:no-underline hover:bg-accent/50 [&[data-state=open]>svg]:rotate-180">
                      <div className="flex items-center gap-2 flex-1 min-w-0 text-left">
                        <span className="font-mono font-semibold text-xs sm:text-sm truncate">
                          {publisher}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[9px] sm:text-[10px] shrink-0",
                            category === "mainstream" && "border-primary/30 text-primary",
                            category === "partisan" && "border-strip-mixed/30 text-strip-mixed",
                            category === "fringe" &&
                              "border-strip-contradicted/30 text-strip-contradicted",
                            category === "reference" &&
                              "border-strip-supported/30 text-strip-supported",
                          )}
                        >
                          {tUI(`categories.${category}`)}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {tUI("units.article", { count: docs.length })}
                        </span>
                        <div className="ml-auto flex items-center gap-1.5 shrink-0">
                          <IntegritySparkline points={getSparklinePoints(publisher)} />
                          {integrityScore !== null && (
                            <ScoreBadge label="I" labelKey="integrity" score={integrityScore} />
                          )}
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="px-3 sm:px-4 pb-3 sm:pb-4 pt-0 space-y-3">
                      {/* Publisher summary */}
                      <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider pt-1">
                        {t("publisherSummary")}
                      </h3>
                      <PublisherAnalysisCard
                        publisherName={publisher}
                        category={category}
                        baselines={pubBaselines}
                      />

                      {/* Article list */}
                      <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider pt-2">
                        {t("articles", { count: docs.length })}
                      </h3>
                      <div className="grid gap-2">
                        {docs.map((doc) => (
                          <ArticleCard key={doc.id} document={doc} />
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>

            {hasMultiplePages && (
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                >
                  {tUI("pagination.previous")}
                </Button>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {tUI("pagination.page", { current: currentPage, total: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                >
                  {tUI("pagination.next")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
