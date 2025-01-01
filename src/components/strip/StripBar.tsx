import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STRIP_COLORS, type StripCell } from "@/lib/types";
import { STRIP_LABEL_NAMES } from "@/lib/types";
import { cn } from "@/lib/utils";

interface StripBarProps {
  cells: StripCell[];
  className?: string;
  onCellClick?: (segmentId: string, index: number) => void;
}

export function StripBar({ cells, className, onCellClick }: StripBarProps) {
  if (!cells || cells.length === 0) {
    return (
      <div className={cn("flex h-3 w-full gap-px rounded-sm overflow-hidden", className)}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="flex-1 bg-muted animate-pulse-strip"
            style={{ animationDelay: `${i * 0.1}s` }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn("flex h-3 w-full gap-px rounded-sm overflow-hidden", className)}>
      {cells.map((cell, i) => (
        <Tooltip key={`${cell.segment_id}-${i}`}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex-1 transition-all hover:scale-y-150 hover:brightness-110",
                STRIP_COLORS[cell.label],
                onCellClick && "cursor-pointer",
              )}
              onClick={() => onCellClick?.(cell.segment_id, i)}
            />
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs font-mono">
            {STRIP_LABEL_NAMES[cell.label]} · Segment {i + 1}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
