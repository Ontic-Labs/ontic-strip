import { PipelineStatusBadge } from "@/components/strip/PipelineStatusBadge";
import { SparkScore } from "@/components/strip/SparkScore";
import { StripSummaryBar } from "@/components/strip/StripSummaryBar";
import { Card, CardContent } from "@/components/ui/card";
import type { Document } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "../../i18n";

interface ArticleCardProps {
  document: Document;
}

export function ArticleCard({ document: doc }: ArticleCardProps) {
  const { t } = useTranslation("feed");
  const navigate = useNavigate();
  const publisherName = doc.feeds?.publisher_name ?? t("unknownPublisher");
  const sourceCategory = doc.feeds?.source_category ?? "mainstream";
  const feedDescription = doc.feeds?.description;
  const timeAgo = doc.published_at
    ? formatDistanceToNow(new Date(doc.published_at), { addSuffix: true, locale: undefined })
    : null;

  const showPipelineBadge = doc.pipeline_status !== "aggregated";

  return (
    <Link to={`/document/${doc.id}`}>
      <Card className="group hover:shadow-md transition-all hover:border-primary/20">
        <CardContent className="p-3 sm:p-4 space-y-2">
          {/* Header row */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm sm:text-base leading-snug line-clamp-2 group-hover:text-primary transition-colors">
                {doc.title ?? t("untitledArticle")}
              </h3>
              <div className="flex flex-col gap-0.5 mt-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    navigate(`/publisher/${encodeURIComponent(publisherName)}`);
                  }}
                  className={cn(
                    "text-[10px] sm:text-xs font-mono font-medium px-1 sm:px-1.5 py-0.5 rounded hover:underline cursor-pointer w-fit",
                    sourceCategory === "mainstream" && "bg-primary/10 text-primary",
                    sourceCategory === "partisan" && "bg-strip-mixed/10 text-strip-mixed",
                    sourceCategory === "fringe" &&
                      "bg-strip-contradicted/10 text-strip-contradicted",
                    sourceCategory === "reference" && "bg-strip-supported/10 text-strip-supported",
                  )}
                >
                  {publisherName}
                </button>
                {timeAgo && (
                  <span className="text-[10px] sm:text-xs text-muted-foreground">{timeAgo}</span>
                )}
              </div>
            </div>
            {showPipelineBadge && (
              <PipelineStatusBadge
                status={doc.pipeline_status}
                className="shrink-0 text-[10px] sm:text-xs"
              />
            )}
          </div>

          {/* Feed description */}
          {feedDescription && (
            <p className="text-[10px] sm:text-xs text-muted-foreground line-clamp-1 italic">
              {feedDescription}
            </p>
          )}

          {/* Article summary from RSS */}
          {doc.raw_content && (
            <p className="text-xs sm:text-sm text-muted-foreground line-clamp-2 leading-relaxed">
              {doc.raw_content
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 200)}
            </p>
          )}

          {/* Strip summary (grouped by label, not positional) */}
          <StripSummaryBar cells={doc.strip ?? []} />

          {/* Scores */}
          <div className="flex items-center gap-3">
            <SparkScore label={t("grounding")} score={doc.grounding_score} />
            <SparkScore label={t("integrity")} score={doc.integrity_score} />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
