import { ArticleCard } from "@/components/feed/ArticleCard";
import { AppLayout } from "@/components/layout/AppLayout";
import { BiasBar } from "@/components/stories/BiasBar";
import { BlindspotBadge } from "@/components/stories/BlindspotBadge";
import { ScoreBadge } from "@/components/strip/ScoreBadge";
import { StripSummaryBar } from "@/components/strip/StripSummaryBar";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { SEOHead } from "@/lib/seo";
import type { Document } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

function toBias(category: string): "left" | "center" | "right" {
  if (category === "lean-left" || category === "partisan-left") return "left";
  if (category === "lean-right" || category === "partisan-right") return "right";
  return "center";
}

type ViewMode = "grouped" | "compare";

export default function StoryDetail() {
  const { id } = useParams<{ id: string }>();
  const [viewMode, setViewMode] = useState<ViewMode>("grouped");

  const { data, isLoading } = useQuery({
    queryKey: ["story-event", id],
    queryFn: async () => {
      // Fetch event (replaces story_clusters)
      const { data: event, error: cErr } = await (supabase as any)
        .from("events")
        .select("id, title, summary, event_type, geo_primary, entities")
        .eq("id", id!)
        .single();

      if (cErr) throw cErr;

      // Fetch documents in this event
      const { data: docs } = await (supabase as any)
        .from("documents")
        .select("*, feeds(*)")
        .eq("event_id", id!)
        .order("published_at", { ascending: false });

      return { cluster: event, documents: (docs ?? []) as unknown as Document[] };
    },
    enabled: !!id,
  });

  const docs = data?.documents ?? [];
  let left = 0;
  let center = 0;
  let right = 0;
  for (const doc of docs) {
    const bias = toBias(doc.feeds?.source_category ?? "mainstream");
    if (bias === "left") left++;
    else if (bias === "right") right++;
    else center++;
  }

  const groundingScores = docs
    .filter((d) => d.grounding_score != null)
    .map((d) => d.grounding_score!);
  const integrityScores = docs
    .filter((d) => d.integrity_score != null)
    .map((d) => d.integrity_score!);
  const avgGrounding =
    groundingScores.length > 0
      ? groundingScores.reduce((a, b) => a + b, 0) / groundingScores.length
      : null;
  const avgIntegrity =
    integrityScores.length > 0
      ? integrityScores.reduce((a, b) => a + b, 0) / integrityScores.length
      : null;

  const topicBenchmarks = (() => {
    const byPublisher = new Map<string, Document[]>();
    for (const doc of docs) {
      const publisher = doc.feeds?.publisher_name ?? "Unknown";
      if (!byPublisher.has(publisher)) byPublisher.set(publisher, []);
      byPublisher.get(publisher)!.push(doc);
    }
    return [...byPublisher.entries()]
      .map(([publisher, publisherDocs]) => {
        const publisherGrounding = publisherDocs
          .map((d) => d.grounding_score)
          .filter((v): v is number => v != null);
        const publisherIntegrity = publisherDocs
          .map((d) => d.integrity_score)
          .filter((v): v is number => v != null);
        const avgPublisherGrounding =
          publisherGrounding.length > 0
            ? publisherGrounding.reduce((s, v) => s + v, 0) / publisherGrounding.length
            : null;
        const avgPublisherIntegrity =
          publisherIntegrity.length > 0
            ? publisherIntegrity.reduce((s, v) => s + v, 0) / publisherIntegrity.length
            : null;
        let contradictedCells = 0;
        let totalCells = 0;
        for (const doc of publisherDocs) {
          for (const cell of doc.strip ?? []) {
            if (cell.label === "CONTRADICTED") contradictedCells++;
            totalCells++;
          }
        }
        return {
          publisher,
          docs: publisherDocs.length,
          avgGrounding: avgPublisherGrounding,
          avgIntegrity: avgPublisherIntegrity,
          contradictionRate: totalCells > 0 ? contradictedCells / totalCells : null,
        };
      })
      .sort((a, b) => (b.avgIntegrity ?? -1) - (a.avgIntegrity ?? -1));
  })();

  return (
    <AppLayout>
      {data?.cluster && (
        <SEOHead
          title={data.cluster.title ?? "Event Detail"}
          description={
            data.cluster.summary ?? `${docs.length} sources covering: ${data.cluster.title}`
          }
          path={`/stories/${id}`}
          ogType="article"
        />
      )}
      <div className="container px-4 sm:px-6 py-6 space-y-6">
        <Link
          to="/stories"
          className="text-xs sm:text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to Stories
        </Link>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-48" />
          </div>
        ) : data?.cluster ? (
          <>
            <div className="space-y-3">
              <h1 className="text-xl font-bold font-mono tracking-tight">{data.cluster.title}</h1>
              {data.cluster.summary && (
                <p className="text-sm text-muted-foreground">{data.cluster.summary}</p>
              )}
              {/* Event metadata */}
              <div className="flex items-center gap-2 flex-wrap">
                {data.cluster.event_type && data.cluster.event_type !== "OTHER" && (
                  <span className="text-[10px] font-mono bg-primary/10 text-primary px-2 py-0.5 rounded">
                    {data.cluster.event_type.replace(/_/g, " ")}
                  </span>
                )}
                {data.cluster.geo_primary && data.cluster.geo_primary !== "unknown" && (
                  <span className="text-[10px] font-mono bg-accent text-accent-foreground px-2 py-0.5 rounded">
                    📍 {data.cluster.geo_primary}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs font-mono text-muted-foreground">
                  {docs.length} source{docs.length !== 1 ? "s" : ""}
                </span>
                <BlindspotBadge left={left} center={center} right={right} />
                <ScoreBadge label="Avg Grounding" labelKey="avgGrounding" score={avgGrounding} />
                <ScoreBadge label="Avg Integrity" labelKey="avgIntegrity" score={avgIntegrity} />
              </div>

              <BiasBar
                left={left}
                center={center}
                right={right}
                total={docs.length}
                className="max-w-md"
              />
            </div>

            {docs.length >= 2 && (
              <div className="flex rounded-md border text-xs font-mono w-fit">
                <button
                  type="button"
                  onClick={() => setViewMode("grouped")}
                  className={cn(
                    "px-3 py-1.5 transition-colors",
                    viewMode === "grouped"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  By Bias
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("compare")}
                  className={cn(
                    "px-3 py-1.5 transition-colors",
                    viewMode === "compare"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  Compare
                </button>
              </div>
            )}

            {viewMode === "grouped" ? (
              (["left", "center", "right"] as const).map((bias) => {
                const biasLabel =
                  bias === "left" ? "Left-Leaning" : bias === "right" ? "Right-Leaning" : "Center";
                const biasColor =
                  bias === "left"
                    ? "text-bias-left"
                    : bias === "right"
                      ? "text-bias-right"
                      : "text-muted-foreground";
                const biasArticles = docs.filter(
                  (d) => toBias(d.feeds?.source_category ?? "mainstream") === bias,
                );
                if (biasArticles.length === 0) return null;
                return (
                  <div key={bias} className="space-y-2">
                    <h2
                      className={`text-xs font-mono font-semibold uppercase tracking-wider ${biasColor}`}
                    >
                      {biasLabel} ({biasArticles.length})
                    </h2>
                    <div className="space-y-2">
                      {biasArticles.map((doc) => (
                        <ArticleCard key={doc.id} document={doc} />
                      ))}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Compare how different outlets covered this event — strips aligned for easy
                  comparison.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {docs
                    .filter((d) => d.integrity_score != null)
                    .sort((a, b) => (b.integrity_score ?? 0) - (a.integrity_score ?? 0))
                    .map((doc) => {
                      const publisher = doc.feeds?.publisher_name ?? "Unknown";
                      const category = doc.feeds?.source_category ?? "mainstream";
                      const bias = toBias(category);
                      return (
                        <Link key={doc.id} to={`/document/${doc.id}`}>
                          <div className="border rounded-lg p-3 sm:p-4 space-y-2.5 hover:shadow-md hover:border-primary/20 transition-all">
                            <div className="flex items-center gap-2">
                              <div
                                className={cn(
                                  "w-2 h-2 rounded-full shrink-0",
                                  bias === "left" && "bg-bias-left",
                                  bias === "center" && "bg-bias-center",
                                  bias === "right" && "bg-bias-right",
                                )}
                              />
                              <span
                                className={cn(
                                  "text-xs font-mono font-medium truncate",
                                  category === "mainstream" && "text-primary",
                                  category === "partisan" && "text-strip-mixed",
                                  category === "fringe" && "text-strip-contradicted",
                                  category === "reference" && "text-strip-supported",
                                )}
                              >
                                {publisher}
                              </span>
                            </div>
                            <h3 className="text-xs sm:text-sm font-semibold leading-snug line-clamp-2">
                              {doc.title ?? "Untitled"}
                            </h3>
                            <StripSummaryBar cells={doc.strip ?? []} />
                            <div className="flex items-center gap-3">
                              <ScoreBadge labelKey="grounding" score={doc.grounding_score} />
                              <ScoreBadge labelKey="integrity" score={doc.integrity_score} />
                            </div>
                            {doc.word_count && (
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {doc.word_count.toLocaleString()} words
                              </span>
                            )}
                          </div>
                        </Link>
                      );
                    })}
                </div>
              </div>
            )}

            {topicBenchmarks.length > 0 && (
              <Card className="border-dashed">
                <CardContent className="p-4 sm:p-5 space-y-3">
                  <h2 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                    Topic benchmarks for this event
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Event-specific publisher performance (not global baseline).
                  </p>
                  <div className="space-y-2">
                    {topicBenchmarks.map((row) => (
                      <div key={row.publisher} className="rounded-md border p-3">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="font-mono text-xs sm:text-sm font-semibold text-foreground">
                            {row.publisher}
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {row.docs} source{row.docs !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="mt-2 flex items-center gap-3 flex-wrap">
                          <ScoreBadge labelKey="eventGrounding" score={row.avgGrounding} />
                          <ScoreBadge labelKey="eventIntegrity" score={row.avgIntegrity} />
                          <span className="text-[10px] font-mono text-muted-foreground">
                            Contradicted cells:{" "}
                            {row.contradictionRate !== null
                              ? `${Math.round(row.contradictionRate * 100)}%`
                              : "—"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        ) : (
          <p className="text-center text-muted-foreground py-16">Event not found.</p>
        )}
      </div>
    </AppLayout>
  );
}
