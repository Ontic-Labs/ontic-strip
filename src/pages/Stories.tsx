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
import { useMemo, useState } from "react";
import { toast } from "sonner";

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

const EVENT_TYPE_LABELS: Record<string, string> = {
  political: "Politics",
  conflict: "Conflict",
  economic: "Economy",
  social: "Social",
  legal: "Legal",
  environmental: "Environment",
  health: "Health",
  technological: "Tech",
  cultural: "Culture",
  disaster: "Disaster",
  diplomatic: "Diplomacy",
  unclassified: "Other",
};

export default function Stories() {
  const [clustering, setClustering] = useState(false);
  const [blindspotOnly, setBlindspotOnly] = useState(false);
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("all");

  const {
    data: clusters,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["story-clusters"],
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
        .select("*, feeds(*)")
        .in("event_id", eventIds);

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
            title: e.title ?? "Untitled Event",
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
            <h1 className="text-xl font-bold font-mono tracking-tight">Stories</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Same story, different perspectives — see how outlets cover the same events
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={runClustering}
            disabled={clustering}
            className="font-mono text-xs"
          >
            {clustering ? "Enriching…" : "↻ Re-enrich"}
          </Button>
        </div>

        {/* Event type filter chips */}
        {eventTypes.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setEventTypeFilter("all")}
              className={cn(
                "px-2.5 py-1 rounded-full text-[10px] font-mono transition-colors border",
                eventTypeFilter === "all"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              All ({clusters?.length ?? 0})
            </button>
            {eventTypes.map(({ type, count }) => (
              <button
                type="button"
                key={type}
                onClick={() => setEventTypeFilter(eventTypeFilter === type ? "all" : type)}
                className={cn(
                  "px-2.5 py-1 rounded-full text-[10px] font-mono transition-colors border",
                  eventTypeFilter === type
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                {EVENT_TYPE_LABELS[type] ?? type} ({count})
              </button>
            ))}
          </div>
        )}

        {/* Bias legend + blindspot/low-coverage filters */}
        <div className="flex items-center gap-4 text-[10px] font-mono text-muted-foreground flex-wrap">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-bias-left" />
            <span>Left</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-bias-center" />
            <span>Center</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-bias-right" />
            <span>Right</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {lowCoverageCount > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] font-mono border-strip-unknown/40 text-strip-unknown"
              >
                {lowCoverageCount} low coverage
              </Badge>
            )}
            {blindspotCount > 0 && (
              <button
                type="button"
                onClick={() => setBlindspotOnly(!blindspotOnly)}
                className={cn(
                  "px-2 py-1 rounded text-[10px] font-mono transition-colors border",
                  blindspotOnly
                    ? "bg-strip-contradicted/10 border-strip-contradicted/30 text-strip-contradicted"
                    : "border-transparent text-muted-foreground hover:bg-accent",
                )}
              >
                {blindspotOnly
                  ? `Showing ${blindspotCount} blindspot${blindspotCount !== 1 ? "s" : ""}`
                  : `${blindspotCount} blindspot${blindspotCount !== 1 ? "s" : ""}`}
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
              {eventTypeFilter !== "all"
                ? "No events match this filter."
                : "No event clusters yet."}
            </p>
            {eventTypeFilter !== "all" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEventTypeFilter("all")}
                className="font-mono text-xs"
              >
                Clear filter
              </Button>
            ) : (
              <Button onClick={runClustering} disabled={clustering} className="font-mono text-xs">
                {clustering ? "Enriching…" : "Run Enrichment Now"}
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {displayClusters.map((cluster) => (
              <StoryCard
                key={cluster.id}
                cluster={cluster}
                lowCoverage={cluster.publisherCount < 3}
                eventType={EVENT_TYPE_LABELS[cluster.event_type] ?? cluster.event_type}
                geo={cluster.geo_primary}
              />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
