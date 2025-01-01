import { Badge } from "@/components/ui/badge";
import type { PipelineStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<
  PipelineStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  normalizing: { label: "Normalizing", variant: "secondary" },
  pending: { label: "Pending", variant: "outline" },
  indexing: { label: "Indexing", variant: "secondary" },
  classifying: { label: "Classifying", variant: "secondary" },
  extracting: { label: "Extracting", variant: "secondary" },
  verifying: { label: "Verifying", variant: "secondary" },
  aggregated: { label: "Complete", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
};

interface PipelineStatusBadgeProps {
  status: PipelineStatus;
  className?: string;
}

export function PipelineStatusBadge({ status, className }: PipelineStatusBadgeProps) {
  const style = STATUS_STYLES[status];
  const isProcessing = [
    "normalizing",
    "indexing",
    "classifying",
    "extracting",
    "verifying",
  ].includes(status);

  return (
    <Badge variant={style.variant} className={cn(isProcessing && "animate-pulse", className)}>
      {style.label}
    </Badge>
  );
}
