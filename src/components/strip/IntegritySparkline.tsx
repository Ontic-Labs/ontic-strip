import { cn } from "@/lib/utils";

interface IntegritySparklineProps {
  /** Daily integrity scores (0–1), ordered oldest→newest. At least 2 points needed. */
  points: number[];
  className?: string;
  width?: number;
  height?: number;
}

function scoreColor(avg: number): string {
  if (avg >= 0.8) return "hsl(var(--strip-supported))";
  if (avg >= 0.6) return "hsl(var(--strip-unknown))";
  if (avg >= 0.4) return "hsl(var(--strip-mixed))";
  return "hsl(var(--strip-contradicted))";
}

export function IntegritySparkline({
  points,
  className,
  width = 48,
  height = 16,
}: IntegritySparklineProps) {
  if (points.length < 2) return null;

  const pad = 1;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 0.1; // avoid division by zero

  const coords = points.map((v, i) => ({
    x: pad + (i / (points.length - 1)) * (width - pad * 2),
    y: pad + (1 - (v - min) / range) * (height - pad * 2),
  }));

  const pathD = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");
  const avg = points.reduce((a, b) => a + b, 0) / points.length;
  const color = scoreColor(avg);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0", className)}
      role="img"
      aria-label={`Integrity trend: ${points.map((p) => `${Math.round(p * 100)}%`).join(", ")}`}
    >
      <title>{`Integrity trend: ${points.map((p) => `${Math.round(p * 100)}%`).join(", ")}`}</title>
      <path
        d={pathD}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* End dot */}
      <circle
        cx={coords[coords.length - 1].x}
        cy={coords[coords.length - 1].y}
        r={1.5}
        fill={color}
      />
    </svg>
  );
}
