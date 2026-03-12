import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { SEOHead } from "@/lib/seo";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "../i18n";

const STAGE_ORDER = [
  "normalizing",
  "pending",
  "classifying",
  "extracting",
  "verifying",
  "aggregated",
  "failed",
] as const;

const STATUS_COLORS: Record<string, string> = {
  aggregated: "bg-strip-supported/20 text-strip-supported",
  normalizing: "bg-strip-opinion/20 text-strip-opinion",
  pending: "bg-strip-unknown/20 text-strip-unknown",
  classifying: "bg-primary/10 text-primary",
  extracting: "bg-primary/10 text-primary",
  verifying: "bg-strip-mixed/20 text-strip-mixed",
  failed: "bg-strip-contradicted/20 text-strip-contradicted",
};

const HEALTH_STYLES = {
  healthy: "bg-strip-supported/10 border-strip-supported/30 text-strip-supported",
  degraded: "bg-strip-mixed/10 border-strip-mixed/30 text-strip-mixed",
  unhealthy: "bg-strip-contradicted/10 border-strip-contradicted/30 text-strip-contradicted",
};
const HEALTH_ICON = { healthy: "●", degraded: "◐", unhealthy: "○" };

export default function JobHealth() {
  const { t } = useTranslation("pages");

  // Pipeline status distribution (server-side GROUP BY via RPC)
  const {
    data: statusCounts,
    isLoading: loadingStatus,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["job-health-status"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("pipeline_status_counts");
      if (error) throw error;
      return data as Record<string, number>;
    },
    refetchInterval: 15_000,
  });

  // Recent stage metrics (last 100)
  const { data: recentMetrics, isLoading: loadingMetrics } = useQuery({
    queryKey: ["job-health-metrics"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pipeline_stage_metrics")
        .select("stage, status, duration_ms, error_message, created_at")
        .order("id", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
    refetchInterval: 15_000,
  });

  // DLQ entries
  const { data: dlqEntries, isLoading: loadingDlq } = useQuery({
    queryKey: ["job-health-dlq"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pipeline_dlq")
        .select("stage, error_message, failed_at, attempt")
        .order("failed_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
    refetchInterval: 30_000,
  });

  // Paused stages
  const { data: pausedStages } = useQuery({
    queryKey: ["job-health-paused"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pipeline_control")
        .select("stage, paused, pause_reason, paused_until, failure_streak")
        .eq("paused", true);
      if (error) throw error;
      return data;
    },
    refetchInterval: 30_000,
  });

  const total = statusCounts ? Object.values(statusCounts).reduce((a, b) => a + b, 0) : 0;

  const allLoaded = !loadingStatus && !loadingMetrics && !loadingDlq;

  // Derive overall health (only after all queries resolve)
  const failedCount = statusCounts?.failed ?? 0;
  const dlqCount = dlqEntries?.length ?? 0;
  const pausedCount = pausedStages?.length ?? 0;
  const hasRecentActivity = (recentMetrics?.length ?? 0) > 0;
  const healthLevel: "healthy" | "degraded" | "unhealthy" =
    failedCount > 10 || dlqCount > 10 || pausedCount > 2 || !hasRecentActivity
      ? "unhealthy"
      : failedCount > 0 || dlqCount > 0 || pausedCount > 0
        ? "degraded"
        : "healthy";

  // Aggregate metrics by stage
  const stageSummary = recentMetrics
    ? (() => {
        const map: Record<string, { ok: number; fail: number; totalMs: number; count: number }> =
          {};
        for (const m of recentMetrics) {
          if (!map[m.stage]) map[m.stage] = { ok: 0, fail: 0, totalMs: 0, count: 0 };
          const entry = map[m.stage];
          if (m.status === "ok") entry.ok++;
          else entry.fail++;
          entry.totalMs += m.duration_ms;
          entry.count++;
        }
        return Object.entries(map)
          .map(([stage, s]) => ({
            stage,
            ok: s.ok,
            fail: s.fail,
            avgMs: Math.round(s.totalMs / s.count),
            failRate: s.count > 0 ? ((s.fail / s.count) * 100).toFixed(1) : "0",
          }))
          .sort((a, b) => b.ok + b.fail - (a.ok + a.fail));
      })()
    : [];

  return (
    <AppLayout>
      <SEOHead title={t("health.title")} description={t("health.description")} path="/health" />
      <div className="container py-4 sm:py-6 space-y-6 px-4 sm:px-6 max-w-4xl">
        {/* Health Check Banner */}
        {allLoaded && (
          <div
            className={cn(
              "rounded-lg border px-4 py-3 flex items-center gap-3 font-mono text-sm",
              HEALTH_STYLES[healthLevel],
            )}
          >
            <span className="text-lg">{HEALTH_ICON[healthLevel]}</span>
            <div className="flex-1">
              <span className="font-bold">{t(`health.check.${healthLevel}`)}</span>
              <span className="ml-2 text-xs opacity-80">
                {failedCount > 0 && t("health.check.failedCount", { count: failedCount })}
                {dlqCount > 0 &&
                  (failedCount > 0 ? " · " : "") + t("health.check.dlqCount", { count: dlqCount })}
                {pausedCount > 0 &&
                  (failedCount > 0 || dlqCount > 0 ? " · " : "") +
                    t("health.check.pausedCount", { count: pausedCount })}
                {!hasRecentActivity && t("health.check.noActivity")}
                {failedCount === 0 &&
                  dlqCount === 0 &&
                  pausedCount === 0 &&
                  hasRecentActivity &&
                  t("health.check.allClear")}
              </span>
            </div>
          </div>
        )}

        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tight">
            {t("health.title")}
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            {t("health.subtitle")}
            {dataUpdatedAt > 0 && (
              <span className="ml-2 text-[10px] text-muted-foreground/60">
                ({t("health.lastUpdated", { time: new Date(dataUpdatedAt).toLocaleTimeString() })})
              </span>
            )}
          </p>
        </div>

        {/* Status Distribution */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-mono">
              {t("health.documentStatus", { total })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingStatus ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8" />
                ))}
              </div>
            ) : (
              <>
                {/* Progress bar */}
                <div className="flex h-6 rounded-md overflow-hidden mb-4">
                  {STAGE_ORDER.filter((s) => (statusCounts?.[s] ?? 0) > 0).map((status) => {
                    const count = statusCounts?.[status] ?? 0;
                    const pct = total > 0 ? (count / total) * 100 : 0;
                    return (
                      <div
                        key={status}
                        className={cn(
                          "flex items-center justify-center text-[10px] font-mono font-medium transition-all",
                          STATUS_COLORS[status] ?? "bg-muted text-muted-foreground",
                        )}
                        style={{ width: `${pct}%` }}
                        title={`${status}: ${count}`}
                      >
                        {pct > 5 ? count : ""}
                      </div>
                    );
                  })}
                </div>
                {/* Table */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {Object.entries(statusCounts ?? {})
                    .sort(([, a], [, b]) => b - a)
                    .map(([status, count]) => (
                      <div
                        key={status}
                        className={cn(
                          "rounded-md px-3 py-2 text-center",
                          STATUS_COLORS[status] ?? "bg-muted text-muted-foreground",
                        )}
                      >
                        <div className="text-lg font-mono font-bold">{count}</div>
                        <div className="text-[10px] font-mono uppercase tracking-wide">
                          {status}
                        </div>
                      </div>
                    ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Paused Stages */}
        {pausedStages && pausedStages.length > 0 && (
          <Card className="border-strip-contradicted/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-mono text-strip-contradicted">
                ⏸ {t("health.pausedStages")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {pausedStages.map((s) => (
                  <div
                    key={s.stage}
                    className="flex items-center justify-between bg-strip-contradicted/5 rounded-md px-3 py-2 text-sm"
                  >
                    <span className="font-mono font-medium">{s.stage}</span>
                    <span className="text-xs text-muted-foreground">
                      {s.pause_reason ?? t("health.streak", { count: s.failure_streak })}
                      {s.paused_until &&
                        ` · ${t("health.until", { time: new Date(s.paused_until).toLocaleTimeString() })}`}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stage Throughput */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-mono">{t("health.recentThroughput")}</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingMetrics ? (
              <Skeleton className="h-32" />
            ) : stageSummary.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                {t("health.noRecentMetrics")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left py-2 px-2">{t("health.stage")}</th>
                      <th className="text-right py-2 px-2">{t("health.ok")}</th>
                      <th className="text-right py-2 px-2">{t("health.fail")}</th>
                      <th className="text-right py-2 px-2">{t("health.failPct")}</th>
                      <th className="text-right py-2 px-2">{t("health.avgMs")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stageSummary.map((s) => (
                      <tr key={s.stage} className="border-b border-border/50">
                        <td className="py-2 px-2 font-medium">{s.stage}</td>
                        <td className="text-right py-2 px-2 text-strip-supported">{s.ok}</td>
                        <td className="text-right py-2 px-2 text-strip-contradicted">
                          {s.fail || "—"}
                        </td>
                        <td
                          className={cn(
                            "text-right py-2 px-2",
                            Number(s.failRate) > 10
                              ? "text-strip-contradicted"
                              : "text-muted-foreground",
                          )}
                        >
                          {s.failRate}%
                        </td>
                        <td className="text-right py-2 px-2 text-muted-foreground">
                          {s.avgMs.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Dead Letter Queue */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-mono">
              {t("health.dlq", { count: dlqEntries?.length ?? 0 })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingDlq ? (
              <Skeleton className="h-24" />
            ) : !dlqEntries || dlqEntries.length === 0 ? (
              <p className="text-sm text-strip-supported text-center py-6 font-mono">
                ✓ {t("health.noDlqEntries")}
              </p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {dlqEntries.map((entry, i) => (
                  <div
                    key={`${entry.failed_at}-${i}`}
                    className="bg-strip-contradicted/5 border border-strip-contradicted/10 rounded-md px-3 py-2"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs font-medium">{entry.stage}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {t("health.attempt", { num: entry.attempt })} ·{" "}
                        {new Date(entry.failed_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-[11px] text-strip-contradicted break-all line-clamp-2">
                      {entry.error_message ?? t("health.noErrorMessage")}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
