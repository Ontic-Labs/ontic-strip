import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslation } from "../../i18n";

interface BiasBarProps {
  left: number;
  center: number;
  right: number;
  total: number;
  className?: string;
}

const BIAS_COLORS = {
  left: "bg-bias-left",
  center: "bg-bias-center",
  right: "bg-bias-right",
};

export function BiasBar({ left, center, right, total, className }: BiasBarProps) {
  const { t } = useTranslation("strip");
  if (total === 0) return null;

  const pctL = Math.round((left / total) * 100);
  const pctC = Math.round((center / total) * 100);
  const pctR = Math.round((right / total) * 100);

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex h-2.5 rounded-full overflow-hidden">
        {pctL > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(BIAS_COLORS.left, "transition-all")}
                style={{ width: `${pctL}%` }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <span className="text-xs font-mono">
                {t("bias.left")}: {left} ({pctL}%)
              </span>
            </TooltipContent>
          </Tooltip>
        )}
        {pctC > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(BIAS_COLORS.center, "transition-all")}
                style={{ width: `${pctC}%` }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <span className="text-xs font-mono">
                {t("bias.center")}: {center} ({pctC}%)
              </span>
            </TooltipContent>
          </Tooltip>
        )}
        {pctR > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(BIAS_COLORS.right, "transition-all")}
                style={{ width: `${pctR}%` }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <span className="text-xs font-mono">
                {t("bias.right")}: {right} ({pctR}%)
              </span>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
        {pctL > 0 && (
          <span>
            {t("bias.left").charAt(0)} {pctL}%
          </span>
        )}
        {pctC > 0 && (
          <span>
            {t("bias.center").charAt(0)} {pctC}%
          </span>
        )}
        {pctR > 0 && (
          <span className="ml-auto">
            {t("bias.right").charAt(0)} {pctR}%
          </span>
        )}
      </div>
    </div>
  );
}
