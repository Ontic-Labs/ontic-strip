import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface IdeologyScores {
  economic: number | null;
  social: number | null;
  confidence?: number | null;
  reasoning?: string;
  method?: string;
  theta_raw?: number | null;
  se?: number | null;
  n_stances?: number;
  n_propositions?: number;
  scoring_version?: number;
  reason?: string;
}

function axisColor(val: number): string {
  const abs = Math.abs(val);
  if (abs <= 2) return "text-muted-foreground";
  if (abs <= 5) return "text-strip-mixed";
  return "text-strip-contradicted";
}

function axisLabel(val: number, axis: "economic" | "social"): string {
  if (axis === "economic") {
    if (val <= -5) return "Strong Left";
    if (val <= -2) return "Left-Lean";
    if (val <= 2) return "Center";
    if (val <= 5) return "Right-Lean";
    return "Strong Right";
  }
  if (val <= -5) return "Strong Progressive";
  if (val <= -2) return "Progressive-Lean";
  if (val <= 2) return "Center";
  if (val <= 5) return "Conservative-Lean";
  return "Strong Conservative";
}

export function IdeologyBadge({ scores }: { scores: IdeologyScores | null }) {
  if (!scores || (scores.economic == null && scores.social == null)) {
    const reason = scores?.reason;
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 text-xs cursor-help">
              <span className="text-muted-foreground">Ideology</span>
              <span className="font-mono text-muted-foreground">—</span>
              {reason && (
                <span className="text-[10px] font-mono text-strip-mixed">insufficient signal</span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px] text-xs">
            {reason === "insufficient_ideological_signal"
              ? "Not enough politically-relevant stances were extracted to compute a reliable ideology score."
              : "No ideology data available for this article."}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const econ = scores.economic ?? 0;
  const social = scores.social ?? 0;

  const tooltipLines = [
    `Economic: ${econ > 0 ? "+" : ""}${econ} (${axisLabel(econ, "economic")})`,
    `Social: ${social > 0 ? "+" : ""}${social} (${axisLabel(social, "social")})`,
    scores.method ? `Method: ${scores.method}` : null,
    scores.n_stances != null
      ? `Stances: ${scores.n_stances} across ${scores.n_propositions ?? 0} propositions`
      : null,
    scores.se != null ? `SE: ±${scores.se}` : null,
    scores.confidence != null ? `Confidence: ${Math.round(scores.confidence * 100)}%` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2.5 text-xs cursor-help">
            <span className="text-muted-foreground">Ideology</span>
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">Econ</span>
              <span className={cn("font-mono font-semibold", axisColor(econ))}>
                {econ > 0 ? "+" : ""}
                {econ}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">Social</span>
              <span className={cn("font-mono font-semibold", axisColor(social))}>
                {social > 0 ? "+" : ""}
                {social}
              </span>
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[280px] text-xs whitespace-pre-line">
          {tooltipLines}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
