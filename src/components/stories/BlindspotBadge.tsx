import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface BlindspotBadgeProps {
  left: number;
  center: number;
  right: number;
}

export function BlindspotBadge({ left, center, right }: BlindspotBadgeProps) {
  const total = left + center + right;
  if (total < 2) return null;

  // Blindspot = one side has 0 coverage
  if (left === 0 && right > 0) {
    return (
      <Badge
        variant="outline"
        className={cn("text-[10px] font-mono border-bias-right text-bias-right")}
      >
        Blindspot for the Left
      </Badge>
    );
  }
  if (right === 0 && left > 0) {
    return (
      <Badge
        variant="outline"
        className={cn("text-[10px] font-mono border-bias-left text-bias-left")}
      >
        Blindspot for the Right
      </Badge>
    );
  }

  return null;
}
