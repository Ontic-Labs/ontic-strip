import { AppLayout } from "@/components/layout/AppLayout";
import { ScoreBadge } from "@/components/strip/ScoreBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { BASE_URL, SEOHead, collectionPageSchema } from "@/lib/seo";
import type { Feed, PublisherBaseline, SourceCategory } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const CATEGORIES: { value: SourceCategory | "all"; label: string; color: string }[] = [
  { value: "all", label: "All", color: "bg-muted text-foreground" },
  { value: "mainstream", label: "Mainstream", color: "bg-primary/10 text-primary" },
  { value: "partisan", label: "Partisan", color: "bg-strip-mixed/10 text-strip-mixed" },
  { value: "fringe", label: "Fringe", color: "bg-strip-contradicted/10 text-strip-contradicted" },
  { value: "reference", label: "Reference", color: "bg-strip-supported/10 text-strip-supported" },
];

const CATEGORY_ORDER: Record<string, number> = {
  mainstream: 0,
  reference: 1,
  partisan: 2,
  fringe: 3,
};

const PUBLISHERS_PER_PAGE = 24;

interface PublisherEntry {
  name: string;
  category: SourceCategory;
  feedCount: number;
}

export default function PublisherList() {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<SourceCategory | "all">("all");
  const [page, setPage] = useState(1);

  const { data: feeds } = useQuery({
    queryKey: ["feeds"],
    queryFn: async () => {
      const { data, error } = await supabase.from("feeds").select("*").order("publisher_name");
      if (error) throw error;
      return data as unknown as Feed[];
    },
  });

  const { data: baselines } = useQuery({
    queryKey: ["publisher_baselines"],
    queryFn: async () => {
      const { data, error } = await supabase.from("publisher_baselines").select("*");
      if (error) throw error;
      return data as unknown as PublisherBaseline[];
    },
  });

  const publishers = useMemo(() => {
    if (!feeds) return [];
    const map = new Map<string, PublisherEntry>();
    for (const feed of feeds) {
      const existing = map.get(feed.publisher_name);
      if (existing) {
        existing.feedCount++;
      } else {
        map.set(feed.publisher_name, {
          name: feed.publisher_name,
          category: feed.source_category,
          feedCount: 1,
        });
      }
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        (CATEGORY_ORDER[a.category] ?? 99) - (CATEGORY_ORDER[b.category] ?? 99) ||
        a.name.localeCompare(b.name),
    );
  }, [feeds]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: publishers.length };
    for (const p of publishers) {
      counts[p.category] = (counts[p.category] || 0) + 1;
    }
    return counts;
  }, [publishers]);

  const filtered = useMemo(() => {
    let list = publishers;
    if (activeCategory !== "all") {
      list = list.filter((p) => p.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return list;
  }, [publishers, activeCategory, search]);

  const totalPublishers = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalPublishers / PUBLISHERS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const pagedPublishers = useMemo(() => {
    const start = (currentPage - 1) * PUBLISHERS_PER_PAGE;
    const end = start + PUBLISHERS_PER_PAGE;
    return filtered.slice(start, end);
  }, [filtered, currentPage]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  // Group filtered publishers by category for section display
  const grouped = useMemo(() => {
    const groups: { category: SourceCategory; label: string; publishers: PublisherEntry[] }[] = [];
    const catMap = new Map<SourceCategory, PublisherEntry[]>();
    for (const p of pagedPublishers) {
      const arr = catMap.get(p.category) || [];
      arr.push(p);
      catMap.set(p.category, arr);
    }
    // Maintain category order
    for (const cat of ["mainstream", "reference", "partisan", "fringe"] as SourceCategory[]) {
      const pubs = catMap.get(cat);
      if (pubs?.length) {
        const catInfo = CATEGORIES.find((c) => c.value === cat);
        groups.push({ category: cat, label: catInfo?.label ?? cat, publishers: pubs });
      }
    }
    return groups;
  }, [pagedPublishers]);

  const getBaseline = (name: string, period: "7d" | "30d") =>
    baselines?.find((b) => b.publisher_name === name && b.period === period);

  return (
    <AppLayout>
      <SEOHead
        title="Publishers"
        description="All tracked news publishers with integrity and grounding baselines by source category."
        path="/publishers"
        jsonLd={collectionPageSchema({
          name: "Publishers",
          description: "All tracked news publishers with integrity baselines",
          url: `${BASE_URL}/publishers`,
        })}
      />
      <div className="container py-4 sm:py-6 space-y-4 sm:space-y-6 px-4 sm:px-6">
        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">Publishers</h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Integrity and grounding baselines across {publishers.length} sources
          </p>
        </div>

        {/* Search + Category Filters */}
        <div className="space-y-3">
          <Input
            placeholder="Search publishers…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="max-w-sm h-8 text-sm"
          />
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((cat) => {
              const count = categoryCounts[cat.value] ?? 0;
              const isActive = activeCategory === cat.value;
              return (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => {
                    setActiveCategory(cat.value);
                    setPage(1);
                  }}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all",
                    isActive
                      ? cn(cat.color, "ring-1 ring-current/20")
                      : "bg-muted/50 text-muted-foreground hover:bg-muted",
                  )}
                >
                  {cat.label}
                  <span
                    className={cn("text-[10px] font-mono", isActive ? "opacity-80" : "opacity-50")}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Results */}
        {filtered.length === 0 ? (
          <div className="text-center py-12 sm:py-20 space-y-3">
            <div className="text-3xl sm:text-4xl">◎</div>
            {publishers.length === 0 ? (
              <>
                <h2 className="text-base sm:text-lg font-semibold">No publishers yet</h2>
                <p className="text-xs sm:text-sm text-muted-foreground">
                  Publishers appear once you add RSS feeds.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-base sm:text-lg font-semibold">No matches</h2>
                <p className="text-xs sm:text-sm text-muted-foreground">
                  Try a different search or category.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-muted-foreground">
              <span>
                Showing publishers {(currentPage - 1) * PUBLISHERS_PER_PAGE + 1}-
                {Math.min(currentPage * PUBLISHERS_PER_PAGE, totalPublishers)} of {totalPublishers}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                >
                  Previous
                </Button>
                <span className="font-mono text-[11px]">
                  Page {currentPage} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                >
                  Next
                </Button>
              </div>
            </div>

            {grouped.map(({ category, label, publishers: groupPubs }) => (
              <section key={category}>
                {/* Only show section headers when showing all categories */}
                {activeCategory === "all" && (
                  <div className="flex items-center gap-2 mb-3">
                    <h2 className="text-sm font-semibold font-mono tracking-tight">{label}</h2>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-[10px] font-mono",
                        CATEGORIES.find((c) => c.value === category)?.color,
                      )}
                    >
                      {groupPubs.length}
                    </Badge>
                  </div>
                )}
                <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                  {groupPubs.map(({ name, category: cat, feedCount }) => {
                    const b7 = getBaseline(name, "7d");
                    const b30 = getBaseline(name, "30d");

                    return (
                      <Link key={name} to={`/publisher/${encodeURIComponent(name)}`}>
                        <Card className="hover:shadow-md transition-all hover:border-primary/20 h-full">
                          <CardContent className="p-3 sm:p-4 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <h3 className="font-semibold text-xs sm:text-sm truncate">{name}</h3>
                              <span
                                className={cn(
                                  "text-[10px] sm:text-xs font-mono px-1.5 py-0.5 rounded shrink-0",
                                  cat === "mainstream" && "bg-primary/10 text-primary",
                                  cat === "partisan" && "bg-strip-mixed/10 text-strip-mixed",
                                  cat === "fringe" &&
                                    "bg-strip-contradicted/10 text-strip-contradicted",
                                  cat === "reference" &&
                                    "bg-strip-supported/10 text-strip-supported",
                                )}
                              >
                                {cat}
                              </span>
                            </div>
                            <div className="flex gap-4 sm:gap-6">
                              <div>
                                <span className="text-[10px] text-muted-foreground font-mono">
                                  7d
                                </span>
                                <div className="flex gap-2 sm:gap-3">
                                  <ScoreBadge label="G" score={b7?.avg_grounding_score ?? null} />
                                  <ScoreBadge label="I" score={b7?.avg_integrity_score ?? null} />
                                </div>
                              </div>
                              <div>
                                <span className="text-[10px] text-muted-foreground font-mono">
                                  30d
                                </span>
                                <div className="flex gap-2 sm:gap-3">
                                  <ScoreBadge label="G" score={b30?.avg_grounding_score ?? null} />
                                  <ScoreBadge label="I" score={b30?.avg_integrity_score ?? null} />
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] sm:text-xs text-muted-foreground">
                              {b7 && <span>{b7.document_count} articles (7d)</span>}
                              {feedCount > 1 && (
                                <span className="font-mono">{feedCount} feeds</span>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
