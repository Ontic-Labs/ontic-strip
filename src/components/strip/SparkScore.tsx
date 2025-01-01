import { cn } from "@/lib/utils";

interface SparkScoreProps {
  label: string;
  score: number | null;
  className?: string;
}

function getScoreBg(score: number): string {
  if (score >= 0.8) return "bg-strip-supported";
  if (score >= 0.6) return "bg-strip-unknown";
  if (score >= 0.4) return "bg-strip-mixed";
  return "bg-strip-contradicted";
}

function getScoreText(score: number): string {
  if (score >= 0.8) return "text-strip-supported";
  if (score >= 0.6) return "text-strip-unknown";
  if (score >= 0.4) return "text-strip-mixed";
  return "text-strip-contradicted";
}

export function SparkScore({ label, score, className }: SparkScoreProps) {
  if (score === null || score === undefined) {
    return (
      <div className={cn("flex items-center gap-1.5 text-[10px] sm:text-xs", className)}>
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-muted-foreground">—</span>
      </div>
    );
  }

  const pct = Math.round(score * 100);

  return (
    <div className={cn("flex items-center gap-1.5 text-[10px] sm:text-xs", className)}>
      <span className="text-muted-foreground">{label}</span>
      <div className="h-1.5 w-10 sm:w-12 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", getScoreBg(score))}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={cn("font-mono font-semibold", getScoreText(score))}>{pct}%</span>
    </div>
  );
}
