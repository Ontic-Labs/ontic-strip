import { ScoreBadge } from "@/components/strip/ScoreBadge";
import { Card, CardContent } from "@/components/ui/card";
import { STRIP_COLORS, STRIP_LABEL_NAMES } from "@/lib/types";
import type { PublisherBaseline, SegmentLabel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatNumber } from "../../lib/format";

interface PublisherAnalysisCardProps {
  publisherName: string;
  category: string;
  baselines: PublisherBaseline[];
}

export function PublisherAnalysisCard({
  publisherName,
  category,
  baselines,
}: PublisherAnalysisCardProps) {
  const { t } = useTranslation("feed");
  const b7 = baselines.find((b) => b.period === "7d");
  const b30raw = baselines.find((b) => b.period === "30d");
  // Hide 30d row when values are identical to 7d (insufficient history)
  const b30 =
    b30raw &&
    b7 &&
    b30raw.avg_grounding_score === b7.avg_grounding_score &&
    b30raw.avg_integrity_score === b7.avg_integrity_score &&
    b30raw.document_count === b7.document_count
      ? undefined
      : b30raw;

  const distributionData = b7?.segment_label_distribution
    ? Object.entries(b7.segment_label_distribution)
        .filter(([, v]) => (v as number) > 0)
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .map(([key, value]) => ({
          key: key as SegmentLabel,
          name: STRIP_LABEL_NAMES[key as keyof typeof STRIP_LABEL_NAMES] ?? key,
          value: value as number,
        }))
    : [];

  const totalSegments = distributionData.reduce((sum, d) => sum + d.value, 0);
  const hasData = b7 || b30;

  return (
    <Card className="border-muted/50">
      <CardContent className="p-3 sm:p-4 space-y-3">
        {!hasData ? (
          <p className="text-[10px] sm:text-xs text-muted-foreground italic">
            {t("noBaselineData")}
          </p>
        ) : (
          <>
            {/* Scores row */}
            <div className="flex items-center gap-6 flex-wrap">
              {b7 && (
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider w-6 shrink-0">
                    7d
                  </span>
                  <ScoreBadge labelKey="grounding" score={b7.avg_grounding_score} />
                  <ScoreBadge labelKey="integrity" score={b7.avg_integrity_score} />
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {t("articleCount", { count: b7.document_count })}
                  </span>
                </div>
              )}
              {b30 && (
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider w-6 shrink-0">
                    30d
                  </span>
                  <ScoreBadge labelKey="grounding" score={b30.avg_grounding_score} />
                  <ScoreBadge labelKey="integrity" score={b30.avg_integrity_score} />
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {t("articleCount", { count: b30.document_count })}
                  </span>
                </div>
              )}
            </div>

            {/* Segment distribution bar */}
            {distributionData.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                  {t("segmentDistribution7d")}
                </span>
                {/* Stacked bar */}
                <div className="flex h-3 rounded-sm overflow-hidden gap-px">
                  {distributionData.map((d) => (
                    <div
                      key={d.key}
                      className={cn("transition-all", STRIP_COLORS[d.key])}
                      style={{ flex: d.value / totalSegments }}
                      title={`${d.name}: ${d.value} (${Math.round((d.value / totalSegments) * 100)}%)`}
                    />
                  ))}
                </div>
                {/* Inline legend */}
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {distributionData.map((d) => (
                    <div key={d.key} className="flex items-center gap-1">
                      <div className={cn("h-2 w-2 rounded-sm shrink-0", STRIP_COLORS[d.key])} />
                      <span className="text-[10px] text-muted-foreground">
                        {d.name} {formatNumber(Math.round((d.value / totalSegments) * 100))}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Link to publisher profile */}
            <Link
              to={`/publisher/${encodeURIComponent(publisherName)}`}
              className="text-[10px] text-primary hover:underline font-mono"
            >
              {t("viewFullProfile")}
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
