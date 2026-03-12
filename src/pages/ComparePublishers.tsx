import { AppLayout } from "@/components/layout/AppLayout";
import { ScoreBadge } from "@/components/strip/ScoreBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import { SEOHead } from "@/lib/seo";
import { STRIP_LABEL_NAMES } from "@/lib/types";
import type { PublisherBaseline } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, Plus, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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

const PUBLISHER_COLORS = ["hsl(217, 91%, 60%)", "hsl(145, 63%, 42%)", "hsl(25, 95%, 53%)"];

export default function ComparePublishers() {
  const [selectedPublishers, setSelectedPublishers] = useState<string[]>([]);
  const [openCombobox, setOpenCombobox] = useState(false);

  const { data: allBaselines, isLoading } = useQuery({
    queryKey: ["publisher_baselines_all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("publisher_baselines").select("*");
      if (error) throw error;
      return data as unknown as PublisherBaseline[];
    },
  });

  const { data: feeds } = useQuery({
    queryKey: ["feeds-categories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feeds")
        .select("publisher_name, source_category")
        .order("publisher_name");
      if (error) throw error;
      return data as { publisher_name: string; source_category: string }[];
    },
  });

  const availablePublishers = useMemo(() => {
    if (!allBaselines) return [];
    const names = new Set(allBaselines.map((b) => b.publisher_name));
    return Array.from(names).sort();
  }, [allBaselines]);

  const categoryMap = useMemo(
    () => new Map(feeds?.map((f) => [f.publisher_name, f.source_category]) ?? []),
    [feeds],
  );

  const addPublisher = (name: string) => {
    if (selectedPublishers.length < 3 && !selectedPublishers.includes(name)) {
      setSelectedPublishers([...selectedPublishers, name]);
    }
    setOpenCombobox(false);
  };

  const removePublisher = (name: string) => {
    setSelectedPublishers(selectedPublishers.filter((p) => p !== name));
  };

  const getBaseline = useCallback(
    (name: string, period: "7d" | "30d") =>
      allBaselines?.find((b) => b.publisher_name === name && b.period === period),
    [allBaselines],
  );

  const getDistributionData = (name: string) => {
    const b7 = getBaseline(name, "7d");
    if (!b7?.segment_label_distribution) return [];
    return Object.entries(b7.segment_label_distribution)
      .filter(([, v]) => v > 0)
      .map(([label, value]) => ({
        name: STRIP_LABEL_NAMES[label as keyof typeof STRIP_LABEL_NAMES] ?? label,
        value,
        fill: PIE_COLORS[label] ?? "hsl(220, 10%, 82%)",
      }));
  };

  // Build grouped bar chart data
  const comparisonData = useMemo(() => {
    if (selectedPublishers.length < 2) return [];
    const metrics = [
      { metric: "Integrity (7d)", period: "7d" as const, key: "avg_integrity_score" as const },
      { metric: "Grounding (7d)", period: "7d" as const, key: "avg_grounding_score" as const },
      { metric: "Factuality (7d)", period: "7d" as const, key: "avg_factuality_score" as const },
      { metric: "Integrity (30d)", period: "30d" as const, key: "avg_integrity_score" as const },
      { metric: "Grounding (30d)", period: "30d" as const, key: "avg_grounding_score" as const },
      { metric: "Factuality (30d)", period: "30d" as const, key: "avg_factuality_score" as const },
    ];
    return metrics.map(({ metric, period, key }) => ({
      metric,
      ...Object.fromEntries(
        selectedPublishers.map((p) => [p, Math.round((getBaseline(p, period)?.[key] ?? 0) * 100)]),
      ),
    }));
  }, [selectedPublishers, getBaseline]);

  // Ideology scatter data for comparing publishers
  const ideologyScatterData = useMemo(() => {
    return selectedPublishers.flatMap((name, i) => {
      const b7 = getBaseline(name, "7d");
      if (b7?.avg_ideology_economic == null) return [];
      return [
        {
          publisher: name,
          economic: b7.avg_ideology_economic,
          social: b7.avg_ideology_social ?? 0,
          fill: PUBLISHER_COLORS[i],
        },
      ];
    });
  }, [selectedPublishers, getBaseline]);

  return (
    <AppLayout>
      <SEOHead
        title="Compare Publishers"
        description="Compare up to 3 publishers side by side on integrity metrics, grounding scores, and segment label distributions."
        path="/compare"
      />
      <div className="container py-4 sm:py-6 space-y-4 sm:space-y-6 px-4 sm:px-6 max-w-5xl">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">
            Compare Publishers
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Select up to 3 publishers to compare their integrity metrics side by side
          </p>
        </div>

        {/* Publisher selector */}
        <div className="flex items-center gap-2 flex-wrap">
          {selectedPublishers.map((name, i) => (
            <Badge key={name} variant="secondary" className="gap-1.5 text-xs font-mono pr-1">
              <div className="h-2 w-2 rounded-full" style={{ background: PUBLISHER_COLORS[i] }} />
              {name}
              <button
                type="button"
                onClick={() => removePublisher(name)}
                className="ml-1 hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {selectedPublishers.length < 3 && (
            <Popover open={openCombobox} onOpenChange={setOpenCombobox}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="text-xs font-mono gap-1.5">
                  <Plus className="h-3 w-3" />
                  Add publisher
                  <ChevronsUpDown className="h-3 w-3 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search publishers..." />
                  <CommandList>
                    <CommandEmpty>No publisher found.</CommandEmpty>
                    <CommandGroup>
                      {availablePublishers
                        .filter((p) => !selectedPublishers.includes(p))
                        .map((p) => (
                          <CommandItem
                            key={p}
                            value={p}
                            onSelect={() => addPublisher(p)}
                            className="text-xs font-mono"
                          >
                            {p}
                            {categoryMap.get(p) && (
                              <span className="ml-auto text-[10px] text-muted-foreground">
                                {categoryMap.get(p)}
                              </span>
                            )}
                          </CommandItem>
                        ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            Loading baselines...
          </div>
        ) : selectedPublishers.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-sm">Select publishers above to start comparing</p>
            <p className="text-xs mt-1">
              Choose from {availablePublishers.length} publishers with baseline data
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Side-by-side cards */}
            <div
              className={cn(
                "grid gap-4",
                selectedPublishers.length === 1 && "grid-cols-1 max-w-md",
                selectedPublishers.length === 2 && "grid-cols-1 sm:grid-cols-2",
                selectedPublishers.length === 3 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
              )}
            >
              {selectedPublishers.map((name, i) => {
                const b7 = getBaseline(name, "7d");
                const b30 = getBaseline(name, "30d");
                const category = categoryMap.get(name) ?? "mainstream";
                const distData = getDistributionData(name);
                const chartConfig = distData.reduce<
                  Record<string, { label: string; color: string }>
                >((acc, d) => {
                  acc[d.name] = { label: d.name, color: d.fill };
                  return acc;
                }, {});

                return (
                  <Card key={name} className="overflow-hidden">
                    <CardHeader className="pb-2 px-3 sm:px-4 pt-3 sm:pt-4">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-3 w-3 rounded-full shrink-0"
                          style={{ background: PUBLISHER_COLORS[i] }}
                        />
                        <Link
                          to={`/publisher/${encodeURIComponent(name)}`}
                          className="font-mono text-sm font-semibold hover:text-primary hover:underline transition-colors truncate"
                        >
                          {name}
                        </Link>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] w-fit",
                          category === "mainstream" && "text-primary border-primary/30",
                          category === "partisan" && "text-strip-mixed border-strip-mixed/30",
                          category === "fringe" &&
                            "text-strip-contradicted border-strip-contradicted/30",
                          category === "reference" &&
                            "text-strip-supported border-strip-supported/30",
                        )}
                      >
                        {category}
                      </Badge>
                    </CardHeader>
                    <CardContent className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-3">
                      {/* 7d */}
                      <div className="space-y-1">
                        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                          7-Day
                        </span>
                        <div className="flex items-center gap-3 flex-wrap">
                          <ScoreBadge label="G" labelKey="grounding" score={b7?.avg_grounding_score ?? null} />
                          <ScoreBadge label="I" labelKey="integrity" score={b7?.avg_integrity_score ?? null} />
                          <ScoreBadge label="F" labelKey="factuality" score={b7?.avg_factuality_score ?? null} />
                          <span className="text-[10px] text-muted-foreground ml-auto font-mono">
                            {b7?.document_count ?? 0} articles
                          </span>
                        </div>
                      </div>
                      {/* 30d */}
                      <div className="space-y-1">
                        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                          30-Day
                        </span>
                        <div className="flex items-center gap-3 flex-wrap">
                          <ScoreBadge label="G" labelKey="grounding" score={b30?.avg_grounding_score ?? null} />
                          <ScoreBadge label="I" labelKey="integrity" score={b30?.avg_integrity_score ?? null} />
                          <ScoreBadge label="F" labelKey="factuality" score={b30?.avg_factuality_score ?? null} />
                          <span className="text-[10px] text-muted-foreground ml-auto font-mono">
                            {b30?.document_count ?? 0} articles
                          </span>
                        </div>
                      </div>
                      {/* Pie */}
                      {distData.length > 0 && (
                        <ChartContainer
                          config={chartConfig}
                          className="mx-auto aspect-square max-h-[160px]"
                        >
                          <PieChart>
                            <ChartTooltip content={<ChartTooltipContent />} />
                            <Pie
                              data={distData}
                              dataKey="value"
                              nameKey="name"
                              innerRadius={30}
                              outerRadius={55}
                            >
                              {distData.map((entry, j) => (
                                <Cell key={j} fill={entry.fill} />
                              ))}
                            </Pie>
                          </PieChart>
                        </ChartContainer>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Comparison bar chart */}
            {comparisonData.length > 0 && (
              <Card>
                <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
                  <CardTitle className="text-xs sm:text-sm font-mono">Score Comparison</CardTitle>
                </CardHeader>
                <CardContent className="px-3 sm:px-6 pb-3 sm:pb-6">
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={comparisonData} barGap={2} barCategoryGap="20%">
                      <XAxis dataKey="metric" tick={{ fontSize: 10 }} />
                      <YAxis
                        domain={[0, 100]}
                        tick={{ fontSize: 10 }}
                        tickFormatter={(v) => `${v}%`}
                        width={40}
                      />
                      <ChartTooltip
                        content={({ active, payload, label }) => {
                          if (!active || !payload?.length) return null;
                          return (
                            <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-sm space-y-1">
                              <div className="font-mono font-semibold">{label}</div>
                              {payload.map((p, k) => (
                                <div key={k} className="flex items-center gap-1.5">
                                  <div
                                    className="h-2 w-2 rounded-full"
                                    style={{ background: p.color }}
                                  />
                                  <span className="truncate max-w-[120px]">
                                    {p.dataKey as string}
                                  </span>
                                  <span className="font-mono ml-auto">{p.value}%</span>
                                </div>
                              ))}
                            </div>
                          );
                        }}
                      />
                      {selectedPublishers.map((pub, i) => (
                        <Bar
                          key={pub}
                          dataKey={pub}
                          fill={PUBLISHER_COLORS[i]}
                          radius={[2, 2, 0, 0]}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="flex items-center gap-4 mt-2 text-[10px] text-muted-foreground font-mono flex-wrap">
                    {selectedPublishers.map((pub, i) => (
                      <div key={pub} className="flex items-center gap-1.5">
                        <div
                          className="h-2 w-2 rounded-full"
                          style={{ background: PUBLISHER_COLORS[i] }}
                        />
                        <span className="truncate max-w-[120px]">{pub}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Ideology comparison scatter */}
            {ideologyScatterData.length >= 2 && (
              <Card>
                <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
                  <CardTitle className="text-xs sm:text-sm font-mono">
                    Ideology Comparison (7d avg)
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Average ideological position per publisher on economic and social axes.
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
                      <ZAxis range={[120, 120]} />
                      <ReferenceLine x={0} className="stroke-muted-foreground/40" />
                      <ReferenceLine y={0} className="stroke-muted-foreground/40" />
                      <ChartTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload;
                          return (
                            <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-sm space-y-0.5">
                              <div className="font-mono font-semibold">{d.publisher}</div>
                              <div>
                                Economic:{" "}
                                <span className="font-mono">
                                  {d.economic > 0 ? "+" : ""}
                                  {d.economic.toFixed(1)}
                                </span>
                              </div>
                              <div>
                                Social:{" "}
                                <span className="font-mono">
                                  {d.social > 0 ? "+" : ""}
                                  {d.social.toFixed(1)}
                                </span>
                              </div>
                            </div>
                          );
                        }}
                      />
                      {ideologyScatterData.map((d, i) => (
                        <Scatter key={d.publisher} data={[d]} fill={d.fill} name={d.publisher} />
                      ))}
                    </ScatterChart>
                  </ResponsiveContainer>
                  <div className="flex items-center gap-4 mt-2 text-[10px] text-muted-foreground font-mono flex-wrap">
                    {selectedPublishers.map((pub, i) => (
                      <div key={pub} className="flex items-center gap-1.5">
                        <div
                          className="h-2 w-2 rounded-full"
                          style={{ background: PUBLISHER_COLORS[i] }}
                        />
                        <span className="truncate max-w-[120px]">{pub}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
