import { ArticleCard } from "@/components/feed/ArticleCard";
import { AppLayout } from "@/components/layout/AppLayout";
import { ScoreBadge } from "@/components/strip/ScoreBadge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { SEOHead } from "@/lib/seo";
import { STRIP_LABEL_NAMES } from "@/lib/types";
import type { Document, PublisherBaseline } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

const PIE_COLORS: Record<string, string> = {
  SUPPORTED: "hsl(145, 63%, 42%)",
  CONTRADICTED: "hsl(0, 72%, 51%)",
  MIXED: "hsl(25, 95%, 53%)",
  UNKNOWN: "hsl(45, 93%, 47%)",
  OPINION: "hsl(217, 91%, 60%)",
  NOT_CHECKABLE: "hsl(220, 10%, 72%)",
  NEUTRAL: "hsl(220, 10%, 82%)",
  OTHER: "hsl(220, 10%, 82%)",
};

export default function PublisherDetail() {
  const { name } = useParams<{ name: string }>();
  const decodedName = decodeURIComponent(name ?? "");

  const { data: baselines, isLoading: baselinesLoading } = useQuery({
    queryKey: ["publisher_baselines", decodedName],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("publisher_baselines")
        .select("*")
        .eq("publisher_name", decodedName);
      if (error) throw error;
      return data as unknown as PublisherBaseline[];
    },
    enabled: !!decodedName,
  });

  const { data: documents, isLoading: docsLoading } = useQuery({
    queryKey: ["publisher_documents", decodedName],
    queryFn: async () => {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
      const { data, error } = await supabase
        .from("documents")
        .select("*, feeds!inner(*)")
        .eq("feeds.publisher_name", decodedName)
        .gte("published_at", ninetyDaysAgo)
        .order("published_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as unknown as Document[];
    },
    enabled: !!decodedName,
  });

  const b7 = baselines?.find((b) => b.period === "7d");
  const b30 = baselines?.find((b) => b.period === "30d");

  const distributionData = b7?.segment_label_distribution
    ? Object.entries(b7.segment_label_distribution)
        .filter(([, v]) => (v as number) > 0)
        .map(([key, value]) => ({
          name: STRIP_LABEL_NAMES[key as keyof typeof STRIP_LABEL_NAMES] ?? key,
          value: value as number,
          fill: PIE_COLORS[key] ?? "hsl(220, 10%, 72%)",
        }))
    : [];

  const chartConfig = distributionData.reduce<Record<string, { label: string; color: string }>>(
    (acc, d) => {
      acc[d.name] = { label: d.name, color: d.fill };
      return acc;
    },
    {},
  );

  // Build weekly trend data from documents
  const trendData = (() => {
    if (!documents?.length) return [];
    const scored = documents.filter((d) => d.integrity_score != null && d.published_at);
    if (scored.length < 2) return [];

    const weekMap = new Map<string, { scores: number[]; grounding: number[] }>();
    for (const doc of scored) {
      const date = new Date(doc.published_at!);
      // Group by week (Monday-based)
      const day = date.getDay();
      const monday = new Date(date);
      monday.setDate(date.getDate() - ((day + 6) % 7));
      const weekKey = monday.toISOString().slice(0, 10);
      if (!weekMap.has(weekKey)) weekMap.set(weekKey, { scores: [], grounding: [] });
      const entry = weekMap.get(weekKey)!;
      entry.scores.push(doc.integrity_score!);
      if (doc.grounding_score != null) entry.grounding.push(doc.grounding_score);
    }

    return Array.from(weekMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, { scores, grounding }]) => ({
        week: new Date(week).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        integrity: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100),
        grounding: grounding.length
          ? Math.round((grounding.reduce((a, b) => a + b, 0) / grounding.length) * 100)
          : null,
        articles: scores.length,
      }));
  })();

  // Ideology scatter data from documents with ideology_scores
  const ideologyData = (() => {
    if (!documents?.length) return [];
    return documents
      .filter((d) => d.ideology_scores != null)
      .map((d) => ({
        economic: d.ideology_scores!.economic,
        social: d.ideology_scores!.social,
        title: (d.title ?? "Untitled").slice(0, 60),
      }));
  })();

  return (
    <AppLayout>
      <SEOHead
        title={decodedName}
        description={`${decodedName} integrity profile — ${b7 ? `7d integrity ${Math.round((b7.avg_integrity_score ?? 0) * 100)}%, grounding ${Math.round((b7.avg_grounding_score ?? 0) * 100)}%, ${b7.document_count ?? 0} articles analyzed` : "grounding scores, integrity baselines, and recent articles"}.`}
        path={`/publisher/${name}`}
      />
      <div className="container py-4 sm:py-6 space-y-4 sm:space-y-6 max-w-4xl px-4 sm:px-6">
        <Link
          to="/publishers"
          className="text-xs sm:text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to Publishers
        </Link>

        <div>
          <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">{decodedName}</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Publisher integrity profile
          </p>
        </div>

        {baselinesLoading ? (
          <div className="space-y-3">
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
            <Skeleton className="h-[250px]" />
          </div>
        ) : (
          <>
            {/* Baseline scores */}
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              <Card>
                <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
                  <CardTitle className="text-xs sm:text-sm font-mono">7-Day Baseline</CardTitle>
                </CardHeader>
                <CardContent className="flex gap-4 sm:gap-6 px-3 sm:px-6 pb-3 sm:pb-6 flex-wrap items-center">
                  <ScoreBadge label="Grounding" score={b7?.avg_grounding_score ?? null} />
                  <ScoreBadge label="Integrity" score={b7?.avg_integrity_score ?? null} />
                  <ScoreBadge label="Factuality" score={b7?.avg_factuality_score ?? null} />
                  <span className="text-[10px] sm:text-xs text-muted-foreground ml-auto">
                    {b7?.document_count ?? 0} articles
                  </span>
                </CardContent>
                <CardContent className="flex gap-4 sm:gap-6 px-3 sm:px-6 pb-3 sm:pb-6 flex-wrap items-center pt-0">
                  <ScoreBadge label="Sourcing Quality" score={b7?.avg_sourcing_quality ?? null} />
                  <ScoreBadge label="Editorialization" score={b7?.avg_one_sidedness ?? null} />
                  {b7?.avg_ideology_economic != null && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">Ideology</span>
                      <span className="font-mono text-muted-foreground">
                        E:{b7.avg_ideology_economic > 0 ? "+" : ""}
                        {b7.avg_ideology_economic.toFixed(1)} S:
                        {b7.avg_ideology_social != null
                          ? (b7.avg_ideology_social > 0 ? "+" : "") +
                            b7.avg_ideology_social.toFixed(1)
                          : "—"}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
                  <CardTitle className="text-xs sm:text-sm font-mono">30-Day Baseline</CardTitle>
                </CardHeader>
                <CardContent className="flex gap-4 sm:gap-6 px-3 sm:px-6 pb-3 sm:pb-6 flex-wrap items-center">
                  <ScoreBadge label="Grounding" score={b30?.avg_grounding_score ?? null} />
                  <ScoreBadge label="Integrity" score={b30?.avg_integrity_score ?? null} />
                  <ScoreBadge label="Factuality" score={b30?.avg_factuality_score ?? null} />
                  <span className="text-[10px] sm:text-xs text-muted-foreground ml-auto">
                    {b30?.document_count ?? 0} articles
                  </span>
                </CardContent>
                <CardContent className="flex gap-4 sm:gap-6 px-3 sm:px-6 pb-3 sm:pb-6 flex-wrap items-center pt-0">
                  <ScoreBadge label="Sourcing Quality" score={b30?.avg_sourcing_quality ?? null} />
                  <ScoreBadge label="Editorialization" score={b30?.avg_one_sidedness ?? null} />
                  {b30?.avg_ideology_economic != null && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">Ideology</span>
                      <span className="font-mono text-muted-foreground">
                        E:{b30.avg_ideology_economic > 0 ? "+" : ""}
                        {b30.avg_ideology_economic.toFixed(1)} S:
                        {b30.avg_ideology_social != null
                          ? (b30.avg_ideology_social > 0 ? "+" : "") +
                            b30.avg_ideology_social.toFixed(1)
                          : "—"}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Distribution chart */}
            {distributionData.length > 0 && (
              <Card>
                <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
                  <CardTitle className="text-xs sm:text-sm font-mono">
                    Segment Label Distribution (7d)
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-3 sm:px-6 pb-3 sm:pb-6">
                  <ChartContainer
                    config={chartConfig}
                    className="mx-auto aspect-square max-h-[200px] sm:max-h-[250px]"
                  >
                    <PieChart>
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Pie data={distributionData} dataKey="value" nameKey="name" innerRadius={40}>
                        {distributionData.map((entry, i) => (
                          <Cell key={i} fill={entry.fill} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ChartContainer>
                </CardContent>
              </Card>
            )}

            {/* Integrity trend */}
            {trendData.length >= 2 && (
              <Card>
                <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
                  <CardTitle className="text-xs sm:text-sm font-mono">Integrity Trend</CardTitle>
                </CardHeader>
                <CardContent className="px-3 sm:px-6 pb-3 sm:pb-6">
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={trendData}>
                      <XAxis dataKey="week" tick={{ fontSize: 10 }} />
                      <YAxis
                        domain={[0, 100]}
                        tick={{ fontSize: 10 }}
                        tickFormatter={(v) => `${v}%`}
                        width={40}
                      />
                      <ChartTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload;
                          return (
                            <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-sm space-y-1">
                              <div className="font-mono font-semibold">Week of {d.week}</div>
                              <div>
                                Integrity: <span className="font-mono">{d.integrity}%</span>
                              </div>
                              {d.grounding != null && (
                                <div>
                                  Grounding: <span className="font-mono">{d.grounding}%</span>
                                </div>
                              )}
                              <div className="text-muted-foreground">
                                {d.articles} article{d.articles !== 1 ? "s" : ""}
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="integrity"
                        stroke="hsl(145, 63%, 42%)"
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        name="Integrity"
                      />
                      <Line
                        type="monotone"
                        dataKey="grounding"
                        stroke="hsl(217, 91%, 60%)"
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        name="Grounding"
                        strokeDasharray="4 4"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                  <div className="flex items-center gap-4 mt-2 text-[10px] text-muted-foreground font-mono">
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-0.5 bg-strip-supported rounded" />
                      <span>Integrity</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-0.5 bg-primary rounded border-dashed" />
                      <span>Grounding</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Ideology scatter plot */}
            {ideologyData.length >= 1 && (
              <Card>
                <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
                  <CardTitle className="text-xs sm:text-sm font-mono">Ideology Map</CardTitle>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Each dot is one article. Axes range from −10 to +10.
                  </p>
                </CardHeader>
                <CardContent className="px-3 sm:px-6 pb-3 sm:pb-6">
                  <ResponsiveContainer width="100%" height={280}>
                    <ScatterChart margin={{ top: 10, right: 10, bottom: 20, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis
                        type="number"
                        dataKey="economic"
                        domain={[-10, 10]}
                        ticks={[-10, -5, 0, 5, 10]}
                        tick={{ fontSize: 10 }}
                        label={{
                          value: "Economic ← Left · Right →",
                          position: "bottom",
                          fontSize: 10,
                          className: "fill-muted-foreground",
                        }}
                      />
                      <YAxis
                        type="number"
                        dataKey="social"
                        domain={[-10, 10]}
                        ticks={[-10, -5, 0, 5, 10]}
                        tick={{ fontSize: 10 }}
                        width={30}
                        label={{
                          value: "← Progressive · Conservative →",
                          angle: -90,
                          position: "insideLeft",
                          fontSize: 10,
                          className: "fill-muted-foreground",
                          dx: -5,
                        }}
                      />
                      <ZAxis range={[40, 40]} />
                      <ReferenceLine x={0} className="stroke-muted-foreground/40" />
                      <ReferenceLine y={0} className="stroke-muted-foreground/40" />
                      <ChartTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload;
                          return (
                            <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-sm space-y-0.5 max-w-[220px]">
                              <div className="font-mono font-semibold truncate">{d.title}</div>
                              <div>
                                Economic:{" "}
                                <span className="font-mono">
                                  {d.economic > 0 ? "+" : ""}
                                  {d.economic}
                                </span>
                              </div>
                              <div>
                                Social:{" "}
                                <span className="font-mono">
                                  {d.social > 0 ? "+" : ""}
                                  {d.social}
                                </span>
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Scatter data={ideologyData} fill="hsl(217, 91%, 60%)" fillOpacity={0.7} />
                    </ScatterChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Recent articles */}
        <div className="space-y-3">
          <h2 className="text-xs sm:text-sm font-mono font-semibold text-muted-foreground uppercase tracking-wider">
            Recent Articles
          </h2>
          {docsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
          ) : documents?.length ? (
            documents.map((doc) => <ArticleCard key={doc.id} document={doc} />)
          ) : (
            <p className="text-xs sm:text-sm text-muted-foreground">No articles yet.</p>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
