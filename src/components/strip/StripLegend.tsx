import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { STRIP_COLORS, type SegmentLabel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { useTranslation } from "../../i18n";

const LEGEND_ORDER: SegmentLabel[] = [
  "SUPPORTED",
  "CONTRADICTED",
  "MIXED",
  "UNKNOWN",
  "OPINION",
  "NOT_CHECKABLE",
  "NEUTRAL",
];

const SCORE_KEYS = ["grounding", "integrity", "sentiment"] as const;

interface StripLegendProps {
  className?: string;
}

export function StripLegend({ className }: StripLegendProps) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation("strip");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex flex-col items-center sm:items-start gap-1 text-xs cursor-pointer hover:opacity-80 transition-opacity w-full",
          className,
        )}
      >
        <div className="flex flex-wrap justify-center sm:justify-start gap-x-4 gap-y-1">
          {LEGEND_ORDER.map((label) => (
            <div key={label} className="flex items-center gap-1.5">
              <div className={cn("h-2.5 w-2.5 rounded-sm shrink-0", STRIP_COLORS[label])} />
              <span className="text-muted-foreground whitespace-nowrap">
                {t(`segmentLabels.${label}`)}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap justify-center sm:justify-start gap-x-4 gap-y-1">
          {SCORE_KEYS.map((key) => (
            <span key={key} className="text-muted-foreground whitespace-nowrap font-mono">
              {t(`scoreLabels.${key}`, { defaultValue: t("sentiment.label") })}
            </span>
          ))}
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">{t("legend.dialogTitle")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-6 text-sm">
            {/* Strip section */}
            <div className="space-y-3">
              <h3 className="font-mono font-semibold text-xs uppercase tracking-wider text-foreground">
                {t("legend.theStrip")}
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                {t("legend.stripExplanation")}
              </p>
              <div className="space-y-2">
                {LEGEND_ORDER.map((label) => (
                  <div key={label} className="flex items-start gap-2">
                    <div
                      className={cn("h-3 w-3 rounded-sm shrink-0 mt-0.5", STRIP_COLORS[label])}
                    />
                    <div>
                      <span className="font-semibold text-foreground">
                        {t(`segmentLabels.${label}`)}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {t(`segmentDescriptions.${label}`)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Scores section */}
            <div className="space-y-3">
              <h3 className="font-mono font-semibold text-xs uppercase tracking-wider text-foreground">
                {t("legend.scoresSection")}
              </h3>
              <div className="space-y-3">
                {SCORE_KEYS.map((key) => (
                  <div key={key}>
                    <div className="font-mono font-semibold text-foreground">
                      {key === "sentiment" ? t("sentiment.label") : t(`scoreLabels.${key}`)}
                    </div>
                    <p className="text-muted-foreground leading-relaxed">
                      {t(`legend.${key}Short`)}. {t(`legend.${key}Detail`)}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Limitations */}
            <div className="space-y-2 border-t pt-4">
              <h3 className="font-mono font-semibold text-xs uppercase tracking-wider text-foreground">
                {t("legend.limitationsSection")}
              </h3>
              <p className="text-muted-foreground leading-relaxed text-xs">
                {t("legend.limitationsText")}
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
