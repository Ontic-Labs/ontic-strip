import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ScoreBadgeProps {
  label: string;
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

const SCORE_DESCRIPTIONS: Record<string, string> = {
  Grounding:
    "Proportion of segments backed by actual evidence (supported, contradicted, or mixed). Higher = more claims had retrievable evidence.",
  "Claim Grounding":
    "Proportion of individual claims with resolved verdicts (supported, contradicted, or mixed) vs total claims extracted.",
  Integrity:
    "Weighted evidence alignment: supports add, contradictions penalize at 1.2×, mixed contributes lightly. Deliberately conservative.",
  "Sourcing Quality":
    "Weighted average of evidence tier quality (T1=1.0 … T5=0.2) with a penalty when fewer than 3 evidence pieces are found.",
  Editorialization:
    "Measures rhetorical intensity via opinion density (40%), sentiment extremity (35%), and classification imbalance (25%). Lower = more balanced.",
  Factuality:
    "Composite score: contradiction rate (40%), sourcing quality (25%), grounding (25%), and editorialization (10%). Higher = more factual.",
};

export function ScoreBadge({ label, score, description, className, status }: ScoreBadgeProps) {
  const tooltipText = description ?? SCORE_DESCRIPTIONS[label];
  const isLowSample = status === "low_sample";

  if (score === null || score === undefined) {
    const inner = (
      <div
        className={cn("flex items-center gap-1.5 text-xs", tooltipText && "cursor-help", className)}
      >
        <span className="text-muted-foreground">{label}</span>
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
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono font-semibold", getScoreColor(score))}>{pct}%</span>
      {isLowSample && (
        <span
          className="text-[10px] font-mono text-strip-mixed"
          title="Low sample size — score may not be reliable"
        >
          ⚠ low sample
        </span>
      )}
    </div>
  );

  if (!tooltipText) return inner;

  const fullTooltip = isLowSample
    ? `${tooltipText}\n\n⚠ Low sample: fewer than 3 checkable segments. This score is a floor artifact and may not reflect true quality.`
    : tooltipText;

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
