import { Badge } from "@/components/ui/badge";
import type { PipelineStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "../../i18n";

const STATUS_STYLES: Record<
  PipelineStatus,
  { variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  normalizing: { variant: "secondary" },
  pending: { variant: "outline" },
  indexing: { variant: "secondary" },
  classifying: { variant: "secondary" },
  extracting: { variant: "secondary" },
  verifying: { variant: "secondary" },
  aggregated: { variant: "default" },
  failed: { variant: "destructive" },
};

interface PipelineStatusBadgeProps {
  status: PipelineStatus;
  className?: string;
}

export function PipelineStatusBadge({ status, className }: PipelineStatusBadgeProps) {
  const { t } = useTranslation("feed");
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
      {t(`pipelineStatuses.${status}`)}
    </Badge>
  );
}
