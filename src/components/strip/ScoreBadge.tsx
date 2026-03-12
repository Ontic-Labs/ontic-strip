import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslation } from "../../i18n";

interface ScoreBadgeProps {
  label?: string;
  labelKey?: string;
  score: number | null;
  description?: string;
  className?: string;
  /** When "low_sample", show a ⚠ badge indicating insufficient data */
  status?: "ok" | "low_sample" | null;
}

function getScoreColor(score: number): string {
  if (score >= 0.8) return "text-strip-supported";
  if (score >= 0.6) return "text-strip-unknown";
  if (score >= 0.4) return "text-strip-mixed";
  return "text-strip-contradicted";
}

export function ScoreBadge({
  label,
  labelKey,
  score,
  description,
  className,
  status,
}: ScoreBadgeProps) {
  const { t } = useTranslation("strip");
  const displayLabel =
    label ?? (labelKey ? t(`scoreLabels.${labelKey}`) : undefined) ?? t("scoreLabels.grounding");
  const tooltipText =
    description ??
    (labelKey
      ? t(`scoreDescriptions.${labelKey}`, {
          defaultValue: displayLabel,
        })
      : label
        ? t(
            `scoreDescriptions.${label.replace(/\s+/g, "").charAt(0).toLowerCase() + label.replace(/\s+/g, "").slice(1)}`,
            { defaultValue: "" },
          ) || undefined
        : undefined);
  const isLowSample = status === "low_sample";

  if (score === null || score === undefined) {
    const inner = (
      <div
        className={cn("flex items-center gap-1.5 text-xs", tooltipText && "cursor-help", className)}
      >
        <span className="text-muted-foreground">{displayLabel}</span>
        <span className="font-mono text-muted-foreground">—</span>
      </div>
    );

    if (!tooltipText) return inner;

    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{inner}</TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px] text-xs">
            {tooltipText}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const pct = Math.round(score * 100);

  const inner = (
    <div
      className={cn("flex items-center gap-1.5 text-xs", tooltipText && "cursor-help", className)}
    >
      <span className="text-muted-foreground">{displayLabel}</span>
      <span className={cn("font-mono font-semibold", getScoreColor(score))}>{pct}%</span>
      {isLowSample && (
        <span className="text-[10px] font-mono text-strip-mixed" title={t("lowSampleWarning")}>
          ⚠ {t("lowSample")}
        </span>
      )}
    </div>
  );

  if (!tooltipText) return inner;

  const fullTooltip = isLowSample ? `${tooltipText}\n\n⚠ ${t("lowSampleTooltip")}` : tooltipText;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{inner}</TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[260px] text-xs whitespace-pre-line">
          {fullTooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
