import { AppLayout } from "@/components/layout/AppLayout";
import { StoryCard } from "@/components/stories/StoryCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { BASE_URL, SEOHead, collectionPageSchema } from "@/lib/seo";
import type { Document } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "../i18n";

const STORIES_PER_PAGE = 24;

function toBias(category: string): "left" | "center" | "right" {
  if (category === "lean-left" || category === "partisan-left") return "left";
  if (category === "lean-right" || category === "partisan-right") return "right";
  return "center";
}

interface EventRow {
  id: string;
  title: string | null;
  summary: string | null;
  updated_at: string;
  document_count: number;
  event_type: string;
  geo_primary: string | null;
  entities: string[];
}

interface StoryCluster {
  id: string;
  title: string;
  summary: string | null;
  documents: Document[];
  event_type: string;
  geo_primary: string | null;
  publisherCount: number;
}

export default function Stories() {
  const { t, i18n } = useTranslation("stories");
  const { t: tUI } = useTranslation("ui");
  const { t: tStrip } = useTranslation("strip");
  const locale = i18n.language;
  const [clustering, setClustering] = useState(false);
  const [blindspotOnly, setBlindspotOnly] = useState(false);
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  const {
    data: clusters,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["story-clusters", locale],
    queryFn: async (): Promise<StoryCluster[]> => {
      const { data: eventRows, error: cErr } = await (supabase as any)
        .from("events")
        .select("id, title, summary, updated_at, document_count, event_type, geo_primary, entities")
        .gte("document_count", 2)
        .order("updated_at", { ascending: false });

      if (cErr) throw cErr;
      if (!eventRows || eventRows.length === 0) return [];

      const eventIds = (eventRows as EventRow[]).map((e) => e.id);
      const { data: docs, error: dErr } = await (supabase as any)
        .from("documents")
        .select("*, feeds!inner(*)")
        .in("event_id", eventIds)
        .eq("feeds.locale", locale);

      if (dErr) throw dErr;

      const docsByEvent = new Map<string, Document[]>();
      for (const doc of (docs ?? []) as unknown as Document[]) {
        const eid = (doc as any).event_id;
        if (!docsByEvent.has(eid)) docsByEvent.set(eid, []);
        docsByEvent.get(eid)!.push(doc);
      }

      return (eventRows as EventRow[])
        .map((e) => {
          const eventDocs = docsByEvent.get(e.id) ?? [];
          const publishers = new Set(eventDocs.map((d) => d.feeds?.publisher_name ?? "Unknown"));
          return {
            id: e.id,
            title: e.title ?? t("untitledEvent"),
            summary: e.summary,
            documents: eventDocs,
            event_type: e.event_type ?? "unclassified",
            geo_primary: e.geo_primary,
            publisherCount: publishers.size,
          };
        })
        .filter((c) => c.documents.length >= 2)
        .sort((a, b) => b.documents.length - a.documents.length);
    },
  });

  const runClustering = async () => {
    setClustering(true);
    try {
      const { data, error } = await supabase.functions.invoke("event-enricher", {
        body: { batch_size: 50 },
      });
      if (error) throw error;
      toast.success(`Enriched ${data?.enriched ?? 0} documents`);
      refetch();
    } catch (e) {
      toast.error(`Enrichment failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setClustering(false);
    }
  };

  // Collect unique event types for filter chips
  const eventTypes = useMemo(() => {
    if (!clusters) return [];
    const counts = new Map<string, number>();
    for (const c of clusters) {
      counts.set(c.event_type, (counts.get(c.event_type) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => ({ type, count }));
  }, [clusters]);

  const blindspotCount = useMemo(() => {
    if (!clusters) return 0;
    return clusters.filter((c) => {
      let left = 0;
      let right = 0;
      for (const doc of c.documents) {
        const bias = toBias(doc.feeds?.source_category ?? "mainstream");
        if (bias === "left") left++;
        if (bias === "right") right++;
      }
      return (left === 0 && right > 0) || (right === 0 && left > 0);
    }).length;
  }, [clusters]);

  const lowCoverageCount = useMemo(() => {
    if (!clusters) return 0;
    return clusters.filter((c) => c.publisherCount < 3).length;
  }, [clusters]);

  const displayClusters = useMemo(() => {
    if (!clusters) return [];
    let result = clusters;
    if (blindspotOnly) {
      result = result.filter((c) => {
        let left = 0;
        let right = 0;
        for (const doc of c.documents) {
          const bias = toBias(doc.feeds?.source_category ?? "mainstream");
          if (bias === "left") left++;
          if (bias === "right") right++;
        }
        return (left === 0 && right > 0) || (right === 0 && left > 0);
      });
    }
    if (eventTypeFilter !== "all") {
      result = result.filter((c) => c.event_type === eventTypeFilter);
    }
    return result;
  }, [clusters, blindspotOnly, eventTypeFilter]);

  const totalStories = displayClusters.length;
  const totalPages = Math.max(1, Math.ceil(totalStories / STORIES_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const hasMultiplePages = totalPages > 1;
  const pagedClusters = useMemo(() => {
    const start = (currentPage - 1) * STORIES_PER_PAGE;
    const end = start + STORIES_PER_PAGE;
    return displayClusters.slice(start, end);
  }, [displayClusters, currentPage]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  return (
    <AppLayout>
      <SEOHead
        title="Stories"
        description="Multi-source story clusters showing how different outlets cover the same events, with bias distribution and blindspot detection."
        path="/stories"
        jsonLd={collectionPageSchema({
          name: "Stories",
          description: "Multi-source story clusters with bias distribution",
          url: `${BASE_URL}/stories`,
        })}
      />
      <div className="container px-4 sm:px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold font-mono tracking-tight">{t("pageTitle")}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t("pageSubtitle")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={runClustering}
            disabled={clustering}
            className="font-mono text-xs"
          >
            {clustering ? t("enriching") : t("reEnrich")}
          </Button>
        </div>

        {/* Event type filter chips */}
        {eventTypes.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => {
                setEventTypeFilter("all");
                setPage(1);
              }}
              className={cn(
                "px-2.5 py-1 rounded-full text-[10px] font-mono transition-colors border",
                eventTypeFilter === "all"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {tUI("categories.all")} ({clusters?.length ?? 0})
            </button>
            {eventTypes.map(({ type, count }) => (
              <button
                type="button"
                key={type}
                onClick={() => {
                  setEventTypeFilter(eventTypeFilter === type ? "all" : type);
                  setPage(1);
                }}
                className={cn(
                  "px-2.5 py-1 rounded-full text-[10px] font-mono transition-colors border",
                  eventTypeFilter === type
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                {tUI(`eventTypes.${type}`) ?? type} ({count})
              </button>
            ))}
          </div>
        )}

        {/* Bias legend + blindspot/low-coverage filters */}
        <div className="flex items-center gap-4 text-[10px] font-mono text-muted-foreground flex-wrap">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-bias-left" />
            <span>{tStrip("bias.left")}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-bias-center" />
            <span>{tStrip("bias.center")}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-bias-right" />
            <span>{tStrip("bias.right")}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {lowCoverageCount > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] font-mono border-strip-unknown/40 text-strip-unknown"
              >
                {t("lowCoverageCount", { count: lowCoverageCount })}
              </Badge>
            )}
            {blindspotCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setBlindspotOnly(!blindspotOnly);
                  setPage(1);
                }}
                className={cn(
                  "px-2 py-1 rounded text-[10px] font-mono transition-colors border",
                  blindspotOnly
                    ? "bg-strip-contradicted/10 border-strip-contradicted/30 text-strip-contradicted"
                    : "border-transparent text-muted-foreground hover:bg-accent",
                )}
              >
                {blindspotOnly
                  ? t("showingBlindspots", { count: blindspotCount })
                  : t("blindspot", { count: blindspotCount })}
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-48 rounded-lg" />
            ))}
          </div>
        ) : !displayClusters || displayClusters.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <p className="text-muted-foreground">
              {eventTypeFilter !== "all" ? t("noEventsFiltered") : t("noEventsYet")}
            </p>
            {eventTypeFilter !== "all" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEventTypeFilter("all");
                  setPage(1);
                }}
                className="font-mono text-xs"
              >
                {t("clearFilter")}
              </Button>
            ) : (
              <Button onClick={runClustering} disabled={clustering} className="font-mono text-xs">
                {clustering ? t("enriching") : t("runEnrichmentNow")}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {tUI("pagination.showingRange", {
                  entity: "stories",
                  start: (currentPage - 1) * STORIES_PER_PAGE + 1,
                  end: Math.min(currentPage * STORIES_PER_PAGE, totalStories),
                  total: totalStories,
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

            <div className="grid gap-4 md:grid-cols-2">
              {pagedClusters.map((cluster) => (
                <StoryCard
                  key={cluster.id}
                  cluster={cluster}
                  lowCoverage={cluster.publisherCount < 3}
                  eventType={tUI(`eventTypes.${cluster.event_type}`) ?? cluster.event_type}
                  geo={cluster.geo_primary}
                />
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
