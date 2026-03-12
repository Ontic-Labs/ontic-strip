import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslation } from "../../i18n";

interface SentimentBadgeProps {
  compound: number | null;
  pos?: number | null;
  neg?: number | null;
  neu?: number | null;
  className?: string;
}

export function SentimentBadge({ compound, pos, neg, neu, className }: SentimentBadgeProps) {
  const { t } = useTranslation("strip");

  if (compound === null || compound === undefined) {
    return null;
  }

  const label = compound >= 0.05 ? "positive" : compound <= -0.05 ? "negative" : "neutral";
  const sign = compound >= 0 ? "+" : "";
  const display = `${sign}${compound.toFixed(2)}`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex items-center gap-1.5 text-xs", className)}>
            <span className="text-muted-foreground">{t("sentiment.label")}</span>
            <span
              className={cn(
                "font-mono font-semibold",
                label === "positive" && "text-strip-supported",
                label === "negative" && "text-strip-contradicted",
                label === "neutral" && "text-muted-foreground",
              )}
            >
              {display}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="text-xs font-mono space-y-0.5">
          <div>
            {t("sentiment.label")}: {t(`sentiment.${label}`)}
          </div>
          {pos != null && (
            <div>
              {t("sentiment.pos")}: {(pos * 100).toFixed(1)}%
            </div>
          )}
          {neg != null && (
            <div>
              {t("sentiment.neg")}: {(neg * 100).toFixed(1)}%
            </div>
          )}
          {neu != null && (
            <div>
              {t("sentiment.neu")}: {(neu * 100).toFixed(1)}%
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
