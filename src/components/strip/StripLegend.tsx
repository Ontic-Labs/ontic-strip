import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  STRIP_COLORS,
  STRIP_LABEL_DESCRIPTIONS,
  STRIP_LABEL_NAMES,
  type SegmentLabel,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { useState } from "react";

const LEGEND_ORDER: SegmentLabel[] = [
  "SUPPORTED",
  "CONTRADICTED",
  "MIXED",
  "UNKNOWN",
  "OPINION",
  "NOT_CHECKABLE",
  "NEUTRAL",
];

const SCORE_DEFINITIONS = [
  {
    label: "Grounding",
    short: "0–100 — Proportion of segments backed by actual evidence",
    detail:
      "Measures evidence coverage: what fraction of segments have supported, contradicted, or mixed verdicts. Segments with no evidence (Unknown) lower the score.",
  },
  {
    label: "Integrity",
    short: "0–100 — Weighted evidence alignment across segments",
    detail:
      "Supported segments contribute positively, contradicted segments incur a 1.2× penalty, mixed segments contribute lightly. Deliberately conservative — contradictions outweigh supports.",
  },
  {
    label: "Sentiment",
    short: "−1 to +1 — Emotional tone of the language",
    detail:
      "Aggregated from per-segment analysis. Presented as supplementary context and does not factor into grounding or integrity calculations.",
  },
];

interface StripLegendProps {
  className?: string;
}

export function StripLegend({ className }: StripLegendProps) {
  const [open, setOpen] = useState(false);

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
                {STRIP_LABEL_NAMES[label]}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap justify-center sm:justify-start gap-x-4 gap-y-1">
          {SCORE_DEFINITIONS.map(({ label }) => (
            <span key={label} className="text-muted-foreground whitespace-nowrap font-mono">
              {label}
            </span>
          ))}
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">How to Read the Results</DialogTitle>
          </DialogHeader>

          <div className="space-y-6 text-sm">
            {/* Strip section */}
            <div className="space-y-3">
              <h3 className="font-mono font-semibold text-xs uppercase tracking-wider text-foreground">
                The Strip
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                The colored bar on each article represents its segments, left to right. Each cell is
                colored by its evidence-alignment label:
              </p>
              <div className="space-y-2">
                {LEGEND_ORDER.map((label) => (
                  <div key={label} className="flex items-start gap-2">
                    <div
                      className={cn("h-3 w-3 rounded-sm shrink-0 mt-0.5", STRIP_COLORS[label])}
                    />
                    <div>
                      <span className="font-semibold text-foreground">
                        {STRIP_LABEL_NAMES[label]}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {STRIP_LABEL_DESCRIPTIONS[label]}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Scores section */}
            <div className="space-y-3">
              <h3 className="font-mono font-semibold text-xs uppercase tracking-wider text-foreground">
                Scores
              </h3>
              <div className="space-y-3">
                {SCORE_DEFINITIONS.map(({ label, short, detail }) => (
                  <div key={label}>
                    <div className="font-mono font-semibold text-foreground">{label}</div>
                    <p className="text-muted-foreground leading-relaxed">
                      {short}. {detail}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Limitations */}
            <div className="space-y-2 border-t pt-4">
              <h3 className="font-mono font-semibold text-xs uppercase tracking-wider text-foreground">
                Limitations
              </h3>
              <p className="text-muted-foreground leading-relaxed text-xs">
                All results reflect alignment between extracted claims and retrieved evidence at
                analysis time. They do not constitute definitive judgments of truth. Scores are
                probabilistic statistical signals, not editorial or legal determinations.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
