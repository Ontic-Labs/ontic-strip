import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslation } from "../../i18n";

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

export function IdeologyBadge({ scores }: { scores: IdeologyScores | null }) {
  const { t } = useTranslation("strip");

  function axisLabel(val: number, axis: "economic" | "social"): string {
    if (axis === "economic") {
      if (val <= -5) return t("ideology.axisLabels.strongLeft");
      if (val <= -2) return t("ideology.axisLabels.leftLean");
      if (val <= 2) return t("ideology.axisLabels.center");
      if (val <= 5) return t("ideology.axisLabels.rightLean");
      return t("ideology.axisLabels.strongRight");
    }
    if (val <= -5) return t("ideology.axisLabels.strongProgressive");
    if (val <= -2) return t("ideology.axisLabels.progressiveLean");
    if (val <= 2) return t("ideology.axisLabels.center");
    if (val <= 5) return t("ideology.axisLabels.conservativeLean");
    return t("ideology.axisLabels.strongConservative");
  }

  if (!scores || (scores.economic == null && scores.social == null)) {
    const reason = scores?.reason;
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 text-xs cursor-help">
              <span className="text-muted-foreground">{t("ideology.label")}</span>
              <span className="font-mono text-muted-foreground">—</span>
              {reason && (
                <span className="text-[10px] font-mono text-strip-mixed">
                  {t("ideology.insufficientSignal")}
                </span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px] text-xs">
            {reason === "insufficient_ideological_signal"
              ? t("ideology.insufficientSignalTooltip")
              : t("ideology.noData")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const econ = scores.economic ?? 0;
  const social = scores.social ?? 0;

  const tooltipLines = [
    `${t("ideology.economic")}: ${econ > 0 ? "+" : ""}${econ} (${axisLabel(econ, "economic")})`,
    `${t("ideology.social")}: ${social > 0 ? "+" : ""}${social} (${axisLabel(social, "social")})`,
    scores.method ? `${t("ideology.method")}: ${scores.method}` : null,
    scores.n_stances != null
      ? `${t("ideology.stances")}: ${scores.n_stances} across ${scores.n_propositions ?? 0} ${t("ideology.propositions")}`
      : null,
    scores.se != null ? `SE: ±${scores.se}` : null,
    scores.confidence != null
      ? `${t("ideology.confidence")}: ${Math.round(scores.confidence * 100)}%`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2.5 text-xs cursor-help">
            <span className="text-muted-foreground">{t("ideology.label")}</span>
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">{t("ideology.econ")}</span>
              <span className={cn("font-mono font-semibold", axisColor(econ))}>
                {econ > 0 ? "+" : ""}
                {econ}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">{t("ideology.social")}</span>
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
