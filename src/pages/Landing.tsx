import { AppLayout } from "@/components/layout/AppLayout";
import { BiasBar } from "@/components/stories/BiasBar";
import { BlindspotBadge } from "@/components/stories/BlindspotBadge";
import { ScoreBadge } from "@/components/strip/ScoreBadge";
import { StripSummaryBar } from "@/components/strip/StripSummaryBar";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { SEOHead, organizationSchema, websiteSchema } from "@/lib/seo";
import type { Document, PublisherBaseline } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

function toBias(category: string): "left" | "center" | "right" {
  if (category === "lean-left" || category === "partisan-left") return "left";
  if (category === "lean-right" || category === "partisan-right") return "right";
  return "center";
}

export default function Landing() {
  const navigate = useNavigate();

  // Live pulse counts
  const { data: articleCount, isError: articleError } = useQuery({
    queryKey: ["pulse-articles"],
    queryFn: async () => {
      const { count } = await supabase
        .from("documents")
        .select("*", { count: "exact", head: true })
        .eq("pipeline_status", "aggregated");
      return count ?? 0;
    },
  });

  const { data: storyCount, isError: storyError } = useQuery({
    queryKey: ["pulse-stories"],
    queryFn: async () => {
      const { count } = await (supabase as any)
        .from("events")
        .select("*", { count: "exact", head: true })
        .gte("document_count", 2);
      return count ?? 0;
    },
  });

  const { data: sourceCount, isError: sourceError } = useQuery({
    queryKey: ["pulse-sources"],
    queryFn: async () => {
      const { count } = await supabase
        .from("feeds")
        .select("*", { count: "exact", head: true })
        .eq("is_active", true);
      return count ?? 0;
    },
  });

  // Top stories (7 days)
  const { data: topStories, isLoading: storiesLoading } = useQuery({
    queryKey: ["digest-stories"],
    queryFn: async () => {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

      const { data: events } = await (supabase as any)
        .from("events")
        .select("id, title, summary, updated_at, event_type, geo_primary")
        .gte("updated_at", weekAgo)
        .gte("document_count", 2)
        .order("updated_at", { ascending: false })
        .limit(5);

      if (!events?.length) return [];

      const eventIds = events.map((e: any) => e.id);
      const { data: docs } = await (supabase as any)
        .from("documents")
        .select("*, feeds(*)")
        .in("event_id", eventIds);

      const docsByEvent = new Map<string, Document[]>();
      for (const doc of (docs ?? []) as unknown as Document[]) {
        const eid = (doc as any).event_id;
        if (!docsByEvent.has(eid)) docsByEvent.set(eid, []);
        docsByEvent.get(eid)!.push(doc);
      }

      return events
        .map((e: any) => ({
          ...e,
          documents: docsByEvent.get(e.id) ?? [],
        }))
        .filter((c: any) => c.documents.length >= 2)
        .sort((a: any, b: any) => b.documents.length - a.documents.length);
    },
  });

  // Publisher rankings (7d)
  const { data: baselines, isLoading: baselinesLoading } = useQuery({
    queryKey: ["digest-baselines"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("publisher_baselines")
        .select("*")
        .eq("period", "7d")
        .order("avg_integrity_score", { ascending: false });
      if (error) throw error;
      return data as unknown as PublisherBaseline[];
    },
  });

  // Best & worst articles (7d)
  const { data: topArticles } = useQuery({
    queryKey: ["digest-top-articles"],
    queryFn: async () => {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data } = await supabase
        .from("documents")
        .select(
          "id, title, integrity_score, grounding_score, strip, feeds(publisher_name, source_category)",
        )
        .eq("pipeline_status", "aggregated")
        .gte("published_at", weekAgo)
        .order("integrity_score", { ascending: false })
        .limit(3);
      return (data ?? []) as unknown as (Pick<
        Document,
        "id" | "title" | "integrity_score" | "grounding_score" | "strip"
      > & { feeds: { publisher_name: string; source_category: string } | null })[];
    },
  });

  const { data: bottomArticles } = useQuery({
    queryKey: ["digest-bottom-articles"],
    queryFn: async () => {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data } = await supabase
        .from("documents")
        .select(
          "id, title, integrity_score, grounding_score, strip, feeds(publisher_name, source_category)",
        )
        .eq("pipeline_status", "aggregated")
        .gte("published_at", weekAgo)
        .not("integrity_score", "is", null)
        .order("integrity_score", { ascending: true })
        .limit(3);
      return (data ?? []) as unknown as (Pick<
        Document,
        "id" | "title" | "integrity_score" | "grounding_score" | "strip"
      > & { feeds: { publisher_name: string; source_category: string } | null })[];
    },
  });

  const blindspotStories =
    topStories?.filter((story) => {
      let left = 0;
      let right = 0;
      for (const doc of story.documents) {
        const bias = toBias(doc.feeds?.source_category ?? "mainstream");
        if (bias === "left") left++;
        if (bias === "right") right++;
      }
      return (left === 0 && right > 0) || (right === 0 && left > 0);
    }) ?? [];

  const hasError = articleError || storyError || sourceError;
  const isLoading = storiesLoading || baselinesLoading;

  const pulseItems = [
    { label: "Articles Analyzed", value: articleCount, icon: "◉" },
    { label: "Stories Tracked", value: storyCount, icon: "◫" },
    { label: "Active Sources", value: sourceCount, icon: "⚙" },
  ];

  const steps = [
    {
      step: "1",
      title: "Collect",
      description:
        "RSS feeds from mainstream, partisan, and independent outlets are continuously ingested.",
      color: "bg-strip-supported",
    },
    {
      step: "2",
      title: "Analyze",
      description:
        "AI extracts claims, retrieves evidence, and assigns veracity labels to every segment.",
      color: "bg-strip-opinion",
    },
    {
      step: "3",
      title: "Compare",
      description:
        "Articles covering the same story are clustered so you can spot bias and coverage gaps.",
      color: "bg-strip-mixed",
    },
  ];

  return (
    <AppLayout>
      <SEOHead
        title="Ontic Strip"
        description="Multi-source news integrity analysis. Weekly top stories, publisher rankings, coverage blindspots, and veracity scoring across the political spectrum."
        path="/"
        jsonLd={[organizationSchema(), websiteSchema()]}
      />
      <div className="container px-4 sm:px-6">
        {/* Hero */}
        <section className="py-12 sm:py-20 text-center space-y-4">
          <div className="flex justify-center gap-1 mb-4">
            {[
              "bg-strip-supported",
              "bg-strip-contradicted",
              "bg-strip-mixed",
              "bg-strip-opinion",
              "bg-strip-unknown",
              "bg-strip-not-checkable",
              "bg-strip-neutral",
            ].map((c) => (
              <div key={c} className={cn("h-8 w-2 rounded-full", c)} />
            ))}
          </div>
          <h1 className="text-2xl sm:text-4xl font-mono font-bold tracking-tight">
            Multi-source news integrity analysis
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground max-w-xl mx-auto">
            See how different outlets cover the same story, with automated claim extraction,
            evidence retrieval, and veracity scoring.
          </p>
        </section>

        {/* Error banner */}
        {hasError && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-center text-xs text-destructive">
            Some data failed to load. Try refreshing the page.
          </div>
        )}

        {/* Live Pulse */}
        <section className="pb-10 sm:pb-14">
          <div className="grid grid-cols-1 min-[400px]:grid-cols-3 gap-3 sm:gap-4">
            {pulseItems.map((item) => (
              <Card key={item.label}>
                <CardContent className="p-4 sm:p-6 text-center space-y-1">
                  <div className="text-2xl">{item.icon}</div>
                  <div className="text-2xl sm:text-3xl font-mono font-bold">
                    {item.value?.toLocaleString() ?? "—"}
                  </div>
                  <div className="text-[10px] sm:text-xs text-muted-foreground font-medium uppercase tracking-wider">
                    {item.label}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Quick links */}
        <section className="pb-6 sm:pb-8 flex flex-wrap items-center justify-center gap-3 sm:gap-5">
          <Link
            to="/leaderboard"
            className="text-xs sm:text-sm text-primary hover:underline font-medium font-mono"
          >
            ▲ Publisher Rankings
          </Link>
          <Link
            to="/publishers"
            className="text-xs sm:text-sm text-primary hover:underline font-medium font-mono"
          >
            ◫ All Publishers
          </Link>
          <Link
            to="/claims"
            className="text-xs sm:text-sm text-primary hover:underline font-medium font-mono"
          >
            ◆ Trending Claims
          </Link>
        </section>

        {isLoading ? (
          <div className="space-y-6 pb-10">
            <Skeleton className="h-48" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        ) : (
          <>
            {/* Top Stories This Week */}
            {topStories && topStories.length > 0 && (
              <section className="pb-10 sm:pb-14 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-wider">
                    Top Stories This Week
                  </h2>
                  <Link to="/stories" className="text-xs text-primary hover:underline font-medium">
                    View all stories →
                  </Link>
                </div>
                <div className="space-y-3">
                  {topStories.map((story) => {
                    let left = 0;
                    let center = 0;
                    let right = 0;
                    for (const doc of story.documents) {
                      const bias = toBias(doc.feeds?.source_category ?? "mainstream");
                      if (bias === "left") left++;
                      else if (bias === "right") right++;
                      else center++;
                    }
                    const scores = story.documents
                      .filter((d) => d.integrity_score != null)
                      .map((d) => d.integrity_score!);
                    const avg = scores.length
                      ? scores.reduce((a, b) => a + b, 0) / scores.length
                      : null;

                    return (
                      <Link key={story.id} to={`/stories/${story.id}`}>
                        <Card className="hover:shadow-md transition-all hover:border-primary/20">
                          <CardContent className="p-3 sm:p-4 space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <h3 className="font-semibold text-xs sm:text-sm leading-snug">
                                {story.title}
                              </h3>
                              <BlindspotBadge left={left} center={center} right={right} />
                            </div>
                            {story.summary && (
                              <p className="text-[10px] sm:text-xs text-muted-foreground line-clamp-2">
                                {story.summary}
                              </p>
                            )}
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="text-[10px] font-mono text-muted-foreground">
                                {story.documents.length} sources
                              </span>
                              <BiasBar
                                left={left}
                                center={center}
                                right={right}
                                total={story.documents.length}
                                className="flex-1 max-w-[200px]"
                              />
                              <ScoreBadge label="Avg Integrity" score={avg} />
                            </div>
                          </CardContent>
                        </Card>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Coverage Blindspots */}
            {blindspotStories.length > 0 && (
              <section className="pb-10 sm:pb-14 space-y-3">
                <h2 className="text-sm font-mono font-semibold text-strip-contradicted uppercase tracking-wider">
                  Coverage Blindspots
                </h2>
                <p className="text-xs text-muted-foreground">
                  Stories covered by only one side of the political spectrum
                </p>
                <div className="space-y-2">
                  {blindspotStories.map((story) => {
                    let left = 0;
                    let center = 0;
                    let right = 0;
                    for (const doc of story.documents) {
                      const bias = toBias(doc.feeds?.source_category ?? "mainstream");
                      if (bias === "left") left++;
                      else if (bias === "right") right++;
                      else center++;
                    }
                    return (
                      <Link key={story.id} to={`/stories/${story.id}`}>
                        <Card className="border-strip-contradicted/20 hover:shadow-md transition-all">
                          <CardContent className="p-3 flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <h3 className="text-xs sm:text-sm font-semibold truncate">
                                {story.title}
                              </h3>
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {story.documents.length} sources
                              </span>
                            </div>
                            <BlindspotBadge left={left} center={center} right={right} />
                          </CardContent>
                        </Card>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Publisher Rankings (7-Day) */}
            {baselines && baselines.length > 0 && (
              <section className="pb-10 sm:pb-14 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-wider">
                    Publisher Rankings (7-Day)
                  </h2>
                  <Link
                    to="/leaderboard"
                    className="text-xs text-primary hover:underline font-medium"
                  >
                    View full leaderboard →
                  </Link>
                </div>
                <Card>
                  <CardContent className="p-0">
                    {baselines.slice(0, 5).map((b, i) => (
                      <Link key={b.id} to={`/publisher/${encodeURIComponent(b.publisher_name)}`}>
                        <div
                          className={cn(
                            "flex items-center gap-3 px-3 sm:px-4 py-2.5 hover:bg-accent/50 transition-colors",
                            i < Math.min(baselines.length, 5) - 1 && "border-b",
                          )}
                        >
                          <span
                            className={cn(
                              "w-6 text-center text-xs font-mono font-bold",
                              i === 0 && "text-strip-supported",
                              i === 1 && "text-primary",
                              i === 2 && "text-strip-mixed",
                              i > 2 && "text-muted-foreground",
                            )}
                          >
                            {i + 1}
                          </span>
                          <span className="flex-1 text-xs sm:text-sm font-medium truncate">
                            {b.publisher_name}
                          </span>
                          <ScoreBadge label="G" score={b.avg_grounding_score} />
                          <ScoreBadge label="I" score={b.avg_integrity_score} />
                          <span className="text-[10px] text-muted-foreground font-mono w-12 text-right">
                            {b.document_count}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </CardContent>
                </Card>
              </section>
            )}

            {/* Best & Worst Articles */}
            <div className="pb-10 sm:pb-14 grid gap-6 sm:grid-cols-2">
              {topArticles && topArticles.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-mono font-semibold text-strip-supported uppercase tracking-wider">
                    Most Grounded Articles
                  </h2>
                  <div className="space-y-2">
                    {topArticles.map((a) => (
                      <Link key={a.id} to={`/document/${a.id}`}>
                        <Card className="hover:shadow-md transition-all hover:border-primary/20">
                          <CardContent className="p-3 space-y-1.5">
                            <h3 className="text-xs font-semibold line-clamp-2">
                              {a.title ?? "Untitled"}
                            </h3>
                            <StripSummaryBar cells={a.strip ?? []} />
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  navigate(
                                    `/publisher/${encodeURIComponent(a.feeds?.publisher_name ?? "")}`,
                                  );
                                }}
                                className="text-[10px] font-mono text-muted-foreground hover:text-primary hover:underline cursor-pointer"
                              >
                                {a.feeds?.publisher_name}
                              </button>
                              <ScoreBadge label="I" score={a.integrity_score} className="ml-auto" />
                            </div>
                          </CardContent>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              {bottomArticles && bottomArticles.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-mono font-semibold text-strip-contradicted uppercase tracking-wider">
                    Least Grounded Articles
                  </h2>
                  <div className="space-y-2">
                    {bottomArticles.map((a) => (
                      <Link key={a.id} to={`/document/${a.id}`}>
                        <Card className="hover:shadow-md transition-all hover:border-primary/20">
                          <CardContent className="p-3 space-y-1.5">
                            <h3 className="text-xs font-semibold line-clamp-2">
                              {a.title ?? "Untitled"}
                            </h3>
                            <StripSummaryBar cells={a.strip ?? []} />
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  navigate(
                                    `/publisher/${encodeURIComponent(a.feeds?.publisher_name ?? "")}`,
                                  );
                                }}
                                className="text-[10px] font-mono text-muted-foreground hover:text-primary hover:underline cursor-pointer"
                              >
                                {a.feeds?.publisher_name}
                              </button>
                              <ScoreBadge label="I" score={a.integrity_score} className="ml-auto" />
                            </div>
                          </CardContent>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </>
        )}

        {/* How It Works */}
        <section className="pb-12 sm:pb-20 space-y-4">
          <h2 className="text-lg sm:text-xl font-mono font-semibold text-center">How It Works</h2>
          <div className="grid sm:grid-cols-3 gap-4">
            {steps.map((s) => (
              <Card key={s.step}>
                <CardContent className="p-5 sm:p-6 space-y-3">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold text-primary-foreground",
                        s.color,
                      )}
                    >
                      {s.step}
                    </div>
                    <h3 className="font-mono font-semibold text-sm">{s.title}</h3>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{s.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </div>
    </AppLayout>
  );
}
