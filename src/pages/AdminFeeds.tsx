import { AppLayout } from "@/components/layout/AppLayout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { SEOHead } from "@/lib/seo";
import type { Feed, SourceCategory } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { useTranslation as useI18nTranslation } from "../i18n";

const CATEGORY_FILTERS: { value: SourceCategory | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mainstream", label: "Mainstream" },
  { value: "partisan", label: "Partisan" },
  { value: "fringe", label: "Fringe" },
  { value: "reference", label: "Reference" },
];

const FEEDS_PER_PAGE = 20;

interface PipelineOpsSummary {
  queue_depth: number;
  dlq_count: number;
  paused_stages: string[];
  last_hour: Array<{
    stage: string;
    total: number;
    ok_count: number;
    failed_count: number;
    fail_rate: number;
    p50_ms: number;
    p95_ms: number;
  }>;
}

export default function AdminFeeds() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { t } = useI18nTranslation("pages");
  const { t: tUI } = useI18nTranslation("ui");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<SourceCategory | "all">("all");
  const [page, setPage] = useState(1);
  const [inoreaderStatus, setInoreaderStatus] = useState<{
    connected: boolean;
    expires_at: string | null;
  } | null>(null);
  const [connectingInoreader, setConnectingInoreader] = useState(false);
  const [newFeed, setNewFeed] = useState({
    url: "",
    publisher_name: "",
    source_category: "mainstream" as SourceCategory,
    polling_interval_minutes: 15,
  });

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const { data, error } = await supabase.functions.invoke("inoreader-auth", {
          body: { action: "status" },
        });
        if (error) throw error;
        setInoreaderStatus(
          (data as { connected: boolean; expires_at: string | null }) ?? {
            connected: false,
            expires_at: null,
          },
        );
      } catch {
        setInoreaderStatus({ connected: false, expires_at: null });
      }
    };
    checkStatus();
  }, []);

  const connectInoreader = async () => {
    setConnectingInoreader(true);
    try {
      const { data, error } = await supabase.functions.invoke("inoreader-auth", {
        body: {
          action: "auth_url",
          redirect_uri: `${window.location.origin}/inoreader/callback`,
        },
      });
      if (error) throw error;
      if ((data as { url?: string })?.url) {
        window.location.href = (data as { url: string }).url;
        return;
      }
      setConnectingInoreader(false);
    } catch {
      toast({
        title: t("admin.error"),
        description: t("admin.failedInoreaderOAuth"),
        variant: "destructive",
      });
      setConnectingInoreader(false);
    }
  };

  const { data: feeds, isLoading } = useQuery({
    queryKey: ["feeds"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feeds")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as unknown as Feed[];
    },
  });

  const { data: opsSummary } = useQuery({
    queryKey: ["pipeline_ops_summary"],
    refetchInterval: 30000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("pipeline_ops_summary");
      if (error) throw error;
      return data as PipelineOpsSummary;
    },
  });

  const addFeed = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("feed-admin", {
        body: { action: "insert", ...newFeed },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
      setDialogOpen(false);
      setNewFeed({
        url: "",
        publisher_name: "",
        source_category: "mainstream",
        polling_interval_minutes: 15,
      });
      toast({ title: t("admin.feedAdded"), description: t("admin.generating") });

      // Fire-and-forget AI description generation
      try {
        const { data: aiData, error: aiError } = await supabase.functions.invoke(
          "generate-feed-description",
          {
            body: { publisher_name: data.publisher_name, url: data.url },
          },
        );
        if (!aiError && aiData?.description) {
          await supabase.functions.invoke("feed-admin", {
            body: { action: "update", id: data.id, description: aiData.description },
          });
          queryClient.invalidateQueries({ queryKey: ["feeds"] });
        }
      } catch {
        // Description is non-critical, silently fail
      }
    },
    onError: (err) => {
      toast({ title: t("admin.error"), description: err.message, variant: "destructive" });
    },
  });

  const toggleFeed = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.functions.invoke("feed-admin", {
        body: { action: "update", id, is_active },
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["feeds"] }),
  });

  const deleteFeed = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.functions.invoke("feed-admin", {
        body: { action: "delete", id },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
      toast({ title: t("admin.feedRemoved") });
    },
  });

  const [pollingFeedId, setPollingFeedId] = useState<string | null>(null);
  const [generatingDescId, setGeneratingDescId] = useState<string | null>(null);

  const generateDescription = async (feed: Feed) => {
    setGeneratingDescId(feed.id);
    try {
      const { data, error } = await supabase.functions.invoke("generate-feed-description", {
        body: { publisher_name: feed.publisher_name, url: feed.url },
      });
      if (error) throw error;
      if (data?.description) {
        await supabase.functions.invoke("feed-admin", {
          body: { action: "update", id: feed.id, description: data.description },
        });
        queryClient.invalidateQueries({ queryKey: ["feeds"] });
        toast({ title: t("admin.descriptionGenerated") });
      }
    } catch (e) {
      toast({ title: t("admin.failedGenerateDescription"), variant: "destructive" });
    } finally {
      setGeneratingDescId(null);
    }
  };

  // Filter feeds by search and category
  const filteredFeeds = useMemo(() => {
    if (!feeds) return [];
    let list = feeds;
    if (categoryFilter !== "all") {
      list = list.filter((f) => f.source_category === categoryFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (f) =>
          f.publisher_name.toLowerCase().includes(q) ||
          f.url.toLowerCase().includes(q) ||
          (f.description ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [feeds, categoryFilter, search]);

  const totalFeeds = filteredFeeds.length;
  const totalPages = Math.max(1, Math.ceil(totalFeeds / FEEDS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const pagedFeeds = useMemo(() => {
    const start = (currentPage - 1) * FEEDS_PER_PAGE;
    const end = start + FEEDS_PER_PAGE;
    return filteredFeeds.slice(start, end);
  }, [filteredFeeds, currentPage]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  // Group filtered feeds by category for display
  const groupedFeeds = useMemo(() => {
    const groups: { category: SourceCategory; feeds: Feed[] }[] = [];
    const catOrder: SourceCategory[] = ["mainstream", "reference", "partisan", "fringe"];
    const catMap = new Map<SourceCategory, Feed[]>();
    for (const f of pagedFeeds) {
      const arr = catMap.get(f.source_category) || [];
      arr.push(f);
      catMap.set(f.source_category, arr);
    }
    for (const cat of catOrder) {
      const items = catMap.get(cat);
      if (items?.length) groups.push({ category: cat, feeds: items });
    }
    return groups;
  }, [pagedFeeds]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: feeds?.length ?? 0 };
    for (const feed of feeds ?? []) {
      counts[feed.source_category] = (counts[feed.source_category] || 0) + 1;
    }
    return counts;
  }, [feeds]);

  const pollSingleFeed = useMutation({
    mutationFn: async ({ id, publisher_name }: { id: string; publisher_name: string }) => {
      setPollingFeedId(id);
      const { data, error } = await supabase.functions.invoke("rss-collector", {
        body: { feed_id: id, max_items: 5 },
      });
      if (error) throw new Error(`${publisher_name}: ${error.message}`);
      return { collected: (data as { collected?: number })?.collected || 0, publisher_name };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast({
        title: `${data.publisher_name}`,
        description: t("admin.articlesCollected", { count: data.collected }),
      });
    },
    onError: (err) => {
      toast({ title: t("admin.pollFailed"), description: err.message, variant: "destructive" });
    },
    onSettled: () => setPollingFeedId(null),
  });

  const pollNow = useMutation({
    mutationFn: async () => {
      const { data: activeFeeds, error: feedsErr } = await supabase
        .from("feeds")
        .select("id, publisher_name")
        .eq("is_active", true);

      if (feedsErr) throw feedsErr;
      if (!activeFeeds?.length) {
        return { collected: 0, feedsPolled: 0, errors: ["No active feeds"] };
      }

      let collected = 0;
      const errors: string[] = [];

      for (const feed of activeFeeds) {
        const { data, error } = await supabase.functions.invoke("rss-collector", {
          body: { feed_id: feed.id, max_items: 5 },
        });

        if (error) {
          errors.push(`${feed.publisher_name}: ${error.message}`);
          continue;
        }

        collected += Number((data as { collected?: number })?.collected || 0);
      }

      return { collected, feedsPolled: activeFeeds.length, errors };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast({
        title: t("admin.collectionComplete"),
        description: t("admin.collectionSummary", {
          collected: data.collected,
          sources: data.feedsPolled,
          errors: data.errors?.length ?? 0,
        }),
      });
    },
    onError: (err) => {
      toast({ title: t("admin.pollFailed"), description: err.message, variant: "destructive" });
    },
  });

  return (
    <AppLayout>
      <SEOHead
        title="Feed Admin"
        description="Manage RSS feeds for Ontic Strip"
        path="/admin/feeds"
        noIndex
      />
      <div className="container py-4 sm:py-6 space-y-4 sm:space-y-6 px-4 sm:px-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">
              {t("admin.title")}
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground">{t("admin.description")}</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {inoreaderStatus?.connected ? (
              <Badge
                variant="outline"
                className="text-strip-supported border-strip-supported text-[10px] sm:text-xs"
              >
                ✓ Inoreader
              </Badge>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={connectInoreader}
                disabled={connectingInoreader}
              >
                {connectingInoreader ? "…" : "🔗 Inoreader"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => pollNow.mutate()}
              disabled={pollNow.isPending}
              title="Polling has a short cooldown to avoid rate limiting"
            >
              {pollNow.isPending ? t("admin.polling") : t("admin.poll")}
            </Button>

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm">{t("admin.addFeed")}</Button>
              </DialogTrigger>
              <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle className="font-mono">{t("admin.addFeedDialog")}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>{t("admin.feedUrl")}</Label>
                    <Input
                      placeholder="https://example.com/rss"
                      value={newFeed.url}
                      onChange={(e) => setNewFeed((p) => ({ ...p, url: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t("admin.publisherName")}</Label>
                    <Input
                      placeholder="e.g. Reuters"
                      value={newFeed.publisher_name}
                      onChange={(e) =>
                        setNewFeed((p) => ({ ...p, publisher_name: e.target.value }))
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>{t("admin.category")}</Label>
                      <Select
                        value={newFeed.source_category}
                        onValueChange={(v) =>
                          setNewFeed((p) => ({ ...p, source_category: v as SourceCategory }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="mainstream">{tUI("categories.mainstream")}</SelectItem>
                          <SelectItem value="partisan">{tUI("categories.partisan")}</SelectItem>
                          <SelectItem value="fringe">{tUI("categories.fringe")}</SelectItem>
                          <SelectItem value="reference">{tUI("categories.reference")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>{t("admin.interval")}</Label>
                      <Input
                        type="number"
                        value={newFeed.polling_interval_minutes}
                        onChange={(e) =>
                          setNewFeed((p) => ({
                            ...p,
                            polling_interval_minutes: Number.parseInt(e.target.value) || 15,
                          }))
                        }
                      />
                    </div>
                  </div>
                  <Button
                    className="w-full"
                    onClick={() => addFeed.mutate()}
                    disabled={!newFeed.url || !newFeed.publisher_name}
                  >
                    {t("admin.addFeedButton")}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Search & Category filter */}
        <div className="flex flex-col sm:flex-row gap-3">
          <Input
            placeholder={t("admin.searchFeeds")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="max-w-sm h-8 text-sm"
          />
          <div className="flex flex-wrap gap-1.5">
            {CATEGORY_FILTERS.map((cat) => {
              const count = categoryCounts[cat.value] ?? 0;
              return (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => {
                    setCategoryFilter(cat.value);
                    setPage(1);
                  }}
                  className={cn(
                    "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all",
                    categoryFilter === cat.value
                      ? "bg-primary/15 text-primary ring-1 ring-primary/20"
                      : "bg-muted/50 text-muted-foreground hover:bg-muted",
                  )}
                >
                  {tUI(`categories.${cat.value}`)}
                  <span className="text-[10px] font-mono opacity-60">{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Card>
            <CardContent className="p-3 sm:p-4 text-center">
              <div className="text-xl sm:text-2xl font-mono font-bold">{feeds?.length ?? 0}</div>
              <div className="text-[10px] sm:text-xs text-muted-foreground">{t("admin.total")}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 sm:p-4 text-center">
              <div className="text-xl sm:text-2xl font-mono font-bold text-strip-supported">
                {feeds?.filter((f) => f.is_active).length ?? 0}
              </div>
              <div className="text-[10px] sm:text-xs text-muted-foreground">
                {t("admin.active")}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 sm:p-4 text-center">
              <div className="text-xl sm:text-2xl font-mono font-bold text-muted-foreground">
                {feeds?.filter((f) => !f.is_active).length ?? 0}
              </div>
              <div className="text-[10px] sm:text-xs text-muted-foreground">
                {t("admin.paused")}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Pipeline Ops */}
        <Card>
          <CardContent className="p-3 sm:p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs sm:text-sm font-semibold font-mono">
                {t("admin.pipelineOps")}
              </h2>
              <span className="text-[10px] sm:text-xs text-muted-foreground">
                {t("admin.refresh30s")}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded bg-muted/40 p-2 text-center">
                <div className="text-base font-mono font-bold">{opsSummary?.queue_depth ?? 0}</div>
                <div className="text-[10px] text-muted-foreground">{t("admin.queue")}</div>
              </div>
              <div className="rounded bg-muted/40 p-2 text-center">
                <div className="text-base font-mono font-bold">{opsSummary?.dlq_count ?? 0}</div>
                <div className="text-[10px] text-muted-foreground">{t("admin.dlq")}</div>
              </div>
              <div className="rounded bg-muted/40 p-2 text-center">
                <div className="text-base font-mono font-bold">
                  {opsSummary?.paused_stages?.length ?? 0}
                </div>
                <div className="text-[10px] text-muted-foreground">{t("admin.pausedStages")}</div>
              </div>
            </div>

            {!!opsSummary?.paused_stages?.length && (
              <div className="flex flex-wrap gap-1">
                {opsSummary.paused_stages.map((stage) => (
                  <Badge key={stage} variant="secondary" className="text-[10px]">
                    {stage}
                  </Badge>
                ))}
              </div>
            )}

            {!!opsSummary?.last_hour?.length && (
              <div className="space-y-1">
                {opsSummary.last_hour.slice(0, 4).map((row) => (
                  <div
                    key={row.stage}
                    className="flex items-center justify-between text-[10px] sm:text-xs"
                  >
                    <span className="font-mono">{row.stage}</span>
                    <span className="text-muted-foreground">
                      fail {Math.round((row.fail_rate || 0) * 100)}% · p95 {row.p95_ms ?? 0}ms
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Feed list */}
        <div className="space-y-6">
          {!isLoading && filteredFeeds.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {tUI("pagination.showing", {
                  from: (currentPage - 1) * FEEDS_PER_PAGE + 1,
                  to: Math.min(currentPage * FEEDS_PER_PAGE, totalFeeds),
                  total: totalFeeds,
                })}
              </span>
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
            </div>
          )}

          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-16 sm:h-20 rounded-lg bg-muted animate-pulse" />
            ))
          ) : filteredFeeds.length === 0 ? (
            <div className="text-center py-12 sm:py-20 space-y-3">
              <div className="text-3xl sm:text-4xl">⚙</div>
              {!feeds?.length ? (
                <>
                  <h2 className="text-base sm:text-lg font-semibold">
                    {t("admin.noFeedsConfigured")}
                  </h2>
                  <p className="text-xs sm:text-sm text-muted-foreground">
                    {t("admin.noFeedsHint")}
                  </p>
                </>
              ) : (
                <>
                  <h2 className="text-base sm:text-lg font-semibold">{tUI("empty.noMatches")}</h2>
                  <p className="text-xs sm:text-sm text-muted-foreground">
                    {tUI("empty.tryDifferent")}
                  </p>
                </>
              )}
            </div>
          ) : (
            groupedFeeds.map(({ category, feeds: catFeeds }) => (
              <section key={category}>
                <div className="flex items-center gap-2 mb-2">
                  <h2 className="text-sm font-semibold font-mono tracking-tight capitalize">
                    {category}
                  </h2>
                  <Badge variant="secondary" className="text-[10px] font-mono">
                    {catFeeds.length}
                  </Badge>
                </div>
                <div className="space-y-2">
                  {catFeeds.map((feed) => (
                    <Card key={feed.id} className={cn(!feed.is_active && "opacity-60")}>
                      <CardContent className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-xs sm:text-sm">
                              {feed.publisher_name}
                            </span>
                            <Badge variant="outline" className="text-[9px] sm:text-[10px]">
                              {feed.source_category}
                            </Badge>
                            {!feed.is_active && (
                              <Badge variant="secondary" className="text-[9px] sm:text-[10px]">
                                {t("admin.paused")}
                              </Badge>
                            )}
                          </div>
                          <p className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 truncate font-mono">
                            {feed.url}
                          </p>
                          {feed.description ? (
                            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1 italic">
                              {feed.description}
                            </p>
                          ) : (
                            <button
                              type="button"
                              className="text-[10px] text-primary hover:underline mt-1 font-mono"
                              onClick={() => generateDescription(feed)}
                              disabled={generatingDescId === feed.id}
                            >
                              {generatingDescId === feed.id
                                ? t("admin.generating")
                                : t("admin.generateDescription")}
                            </button>
                          )}
                          <div className="flex gap-2 sm:gap-3 mt-1 text-[10px] sm:text-xs text-muted-foreground">
                            <span>
                              {t("admin.every", { minutes: feed.polling_interval_minutes })}
                            </span>
                            {feed.last_polled_at && (
                              <span>
                                {t("admin.polled")}{" "}
                                {formatDistanceToNow(new Date(feed.last_polled_at), {
                                  addSuffix: true,
                                })}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 sm:gap-2 self-end sm:self-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() =>
                              pollSingleFeed.mutate({
                                id: feed.id,
                                publisher_name: feed.publisher_name,
                              })
                            }
                            disabled={pollingFeedId === feed.id}
                          >
                            {pollingFeedId === feed.id ? "…" : "⟳"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() =>
                              toggleFeed.mutate({ id: feed.id, is_active: !feed.is_active })
                            }
                          >
                            {feed.is_active ? t("admin.pause") : t("admin.resume")}
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                              >
                                {t("admin.delete")}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  {t("admin.removeFeed", { name: feed.publisher_name })}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t("admin.removeFeedDescription")}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{tUI("button.cancel")}</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => deleteFeed.mutate(feed.id)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  {t("admin.delete")}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </AppLayout>
  );
}
