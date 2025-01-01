import { ScoreBadge } from "@/components/strip/ScoreBadge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { Document } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { Link } from "react-router-dom";
import { BiasBar } from "./BiasBar";
import { BlindspotBadge } from "./BlindspotBadge";

function toBias(category: string): "left" | "center" | "right" {
  if (category === "lean-left" || category === "partisan-left") return "left";
  if (category === "lean-right" || category === "partisan-right") return "right";
  return "center";
}

interface StoryCardProps {
  cluster: {
    id: string;
    title: string;
    summary: string | null;
    documents: Document[];
  };
  lowCoverage?: boolean;
  eventType?: string;
  geo?: string | null;
}

export function StoryCard({ cluster, lowCoverage, eventType, geo }: StoryCardProps) {
  const docs = cluster.documents;
  const total = docs.length;

  let left = 0;
  let center = 0;
  let right = 0;
  const publishers = new Set<string>();
  for (const doc of docs) {
    const cat = doc.feeds?.source_category ?? "mainstream";
    const bias = toBias(cat);
    if (bias === "left") left++;
    else if (bias === "right") right++;
    else center++;
    publishers.add(doc.feeds?.publisher_name ?? "Unknown");
  }

  const VERACITY_LABELS = new Set(["SUPPORTED", "CONTRADICTED", "MIXED", "UNKNOWN"]);
  let claimCount = 0;
  for (const doc of docs) {
    if (doc.strip) {
      for (const cell of doc.strip) {
        if (VERACITY_LABELS.has(cell.label)) claimCount++;
      }
    }
  }

  const groundingScores = docs
    .filter((d) => d.grounding_score != null)
    .map((d) => d.grounding_score!);
  const integrityScores = docs
    .filter((d) => d.integrity_score != null)
    .map((d) => d.integrity_score!);
  const avgGrounding =
    groundingScores.length > 0
      ? groundingScores.reduce((a, b) => a + b, 0) / groundingScores.length
      : null;
  const avgIntegrity =
    integrityScores.length > 0
      ? integrityScores.reduce((a, b) => a + b, 0) / integrityScores.length
      : null;

  const latestDoc = docs.reduce((a, b) => {
    if (!a.published_at) return b;
    if (!b.published_at) return a;
    return new Date(a.published_at) > new Date(b.published_at) ? a : b;
  }, docs[0]);
  const timeAgo = latestDoc?.published_at
    ? formatDistanceToNow(new Date(latestDoc.published_at), { addSuffix: true })
    : null;

  return (
    <Card className="hover:shadow-md transition-all hover:border-primary/20">
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {/* Event type + geo tags */}
            <div className="flex items-center gap-1.5 mb-1">
              {eventType && (
                <Badge variant="secondary" className="text-[9px] font-mono px-1.5 py-0">
                  {eventType}
                </Badge>
              )}
              {geo && <span className="text-[9px] font-mono text-muted-foreground">📍 {geo}</span>}
            </div>
            <Link to={`/stories/${cluster.id}`} className="hover:text-primary transition-colors">
              <h3 className="font-semibold text-sm leading-snug line-clamp-2">{cluster.title}</h3>
            </Link>
            {cluster.summary && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{cluster.summary}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Badge variant="secondary" className="text-[10px] font-mono">
              {total} source{total !== 1 ? "s" : ""}
            </Badge>
            {claimCount > 0 && (
              <Badge variant="outline" className="text-[10px] font-mono">
                {claimCount} claim{claimCount !== 1 ? "s" : ""}
              </Badge>
            )}
            {lowCoverage && (
              <Badge
                variant="outline"
                className={cn("text-[10px] font-mono border-strip-unknown/50 text-strip-unknown")}
              >
                Low Coverage
              </Badge>
            )}
            <BlindspotBadge left={left} center={center} right={right} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <BiasBar left={left} center={center} right={right} total={total} />

        <div className="flex flex-wrap gap-1">
          {Array.from(publishers).map((pub) => (
            <Link
              key={pub}
              to={`/publisher/${encodeURIComponent(pub)}`}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:text-primary hover:underline transition-colors"
            >
              {pub}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <ScoreBadge label="Avg Grounding" score={avgGrounding} />
          <ScoreBadge label="Avg Integrity" score={avgIntegrity} />
          {timeAgo && (
            <span className="text-[10px] text-muted-foreground ml-auto font-mono">{timeAgo}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
