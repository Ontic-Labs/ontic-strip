import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STRIP_COLORS, STRIP_LABEL_NAMES, type SegmentLabel, type StripCell } from "@/lib/types";
import { cn } from "@/lib/utils";

interface StripSummaryBarProps {
  cells: StripCell[];
  className?: string;
}

// Ordered from "verified" to "problematic" so the bar reads left→right intuitively
const LABEL_ORDER: SegmentLabel[] = [
  "SUPPORTED",
  "NEUTRAL",
  "NOT_CHECKABLE",
  "OPINION",
  "MIXED",
  "UNKNOWN",
  "CONTRADICTED",
];

export function StripSummaryBar({ cells, className }: StripSummaryBarProps) {
  if (!cells || cells.length === 0) return null;

  const total = cells.length;
  const counts = new Map<SegmentLabel, number>();
  for (const cell of cells) {
    counts.set(cell.label, (counts.get(cell.label) ?? 0) + 1);
  }

  const segments = LABEL_ORDER.filter((label) => (counts.get(label) ?? 0) > 0).map((label) => ({
    label,
    count: counts.get(label)!,
    pct: Math.round((counts.get(label)! / total) * 100),
  }));

  // Handle OTHER if present (not in LABEL_ORDER)
  const otherCount = counts.get("OTHER" as SegmentLabel) ?? 0;
  if (otherCount > 0) {
    segments.push({
      label: "OTHER" as SegmentLabel,
      count: otherCount,
      pct: Math.round((otherCount / total) * 100),
    });
  }

  return (
    <div className={cn("flex h-2.5 rounded-full overflow-hidden", className)}>
      {segments.map((seg) => (
        <Tooltip key={seg.label}>
          <TooltipTrigger asChild>
            <div
              className={cn("transition-all", STRIP_COLORS[seg.label])}
              style={{ width: `${seg.pct}%`, minWidth: seg.pct > 0 ? "3px" : 0 }}
            />
          </TooltipTrigger>
          <TooltipContent side="top">
            <span className="text-xs font-mono">
              {STRIP_LABEL_NAMES[seg.label]}: {seg.count} ({seg.pct}%)
            </span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
