import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  computePersistedScores,
} from "../_shared/scoring-math.ts";
import type { SourcingInputs, OneSidednessInputs, ClaimGroundingInputs } from "../_shared/scoring-math.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let documentId: string | null = null;
    let batchSize = 10;
    try {
      const body = await req.json();
      documentId = body.document_id || null;
      batchSize = body.batch_size || 10;
    } catch {
      // No body
    }

    let query = supabase
      .from("documents")
      .select("id, feed_id, sentiment_compound")
      .eq("pipeline_status", "aggregated")
      .is("strip", null)
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (documentId) {
      query = supabase
        .from("documents")
        .select("id, feed_id, sentiment_compound")
        .eq("id", documentId)
        .limit(1);
    }

    const { data: docs, error: docsErr } = await query;
    if (docsErr) throw docsErr;
    if (!docs || docs.length === 0) {
      return new Response(
        JSON.stringify({ aggregated: 0, message: "No documents to aggregate" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalAggregated = 0;
    const errors: string[] = [];

    for (const doc of docs) {
      try {
        // Get segments
        const { data: segments, error: segErr } = await supabase
          .from("segments")
          .select("id, label, classification, position_index")
          .eq("document_id", doc.id)
          .order("position_index", { ascending: true });

        if (segErr) throw segErr;
        if (!segments || segments.length === 0) continue;

        const strip = segments.map((s) => ({
          label: s.label || "OTHER",
          segment_id: s.id,
        }));

        // Label counts
        const labelCounts: Record<string, number> = {};
        for (const s of segments) {
          const label = s.label || "OTHER";
          labelCounts[label] = (labelCounts[label] || 0) + 1;
        }

        // Classification counts for one-sidedness
        const classCounts: Record<string, number> = {};
        for (const s of segments) {
          const cls = s.classification || "OTHER";
          classCounts[cls] = (classCounts[cls] || 0) + 1;
        }

        const supported = labelCounts["SUPPORTED"] || 0;
        const contradicted = labelCounts["CONTRADICTED"] || 0;
        const mixed = labelCounts["MIXED"] || 0;
        const unknown = labelCounts["UNKNOWN"] || 0;
        // Grounding denominator excludes all non-checkable labels
        const nonCheckableCount = (labelCounts["OTHER"] || 0)
          + (labelCounts["OPINION"] || 0)
          + (labelCounts["NOT_CHECKABLE"] || 0)
          + (labelCounts["NEUTRAL"] || 0);
        const checkableTotal = segments.length - nonCheckableCount;
        const totalAllSegments = segments.length;

        // Get evidence tier distribution for sourcing quality
        // AND claim-level veracity for claim_grounding
        const { data: allClaims } = await supabase
          .from("claims")
          .select("id, veracity_label")
          .eq("document_id", doc.id);

        let sourcingInputs: SourcingInputs | undefined;
        let claimGroundingInputs: ClaimGroundingInputs | undefined;

        if (allClaims && allClaims.length > 0) {
          // Claim grounding: how many claims have resolved verdicts
          const supportedClaims = allClaims.filter(c => c.veracity_label === "SUPPORTED").length;
          const contradictedClaims = allClaims.filter(c => c.veracity_label === "CONTRADICTED").length;
          const mixedClaims = allClaims.filter(c => c.veracity_label === "MIXED").length;
          claimGroundingInputs = {
            supportedClaims,
            contradictedClaims,
            mixedClaims,
            totalClaims: allClaims.length,
          };

          const claimIds = allClaims.map((c) => c.id);
          const { data: evidenceRows } = await supabase
            .from("evidence")
            .select("source_tier")
            .in("claim_id", claimIds);

          if (evidenceRows && evidenceRows.length > 0) {
            const tierCounts: Record<string, number> = {};
            for (const e of evidenceRows) {
              tierCounts[e.source_tier] = (tierCounts[e.source_tier] || 0) + 1;
            }
            sourcingInputs = { tierCounts };
          }
        }

        // One-sidedness inputs
        const opinionCount = classCounts["OPINION_ANALYSIS"] || 0;
        const factualCount = classCounts["FACTUAL_CLAIM"] || 0;
        const sentimentExtremity = Math.abs(doc.sentiment_compound || 0);

        // Editorialization uses total segments (captures overall tone including NC)
        const oneSidednessInputs: OneSidednessInputs = {
          opinionRatio: totalAllSegments > 0 ? opinionCount / totalAllSegments : 0,
          sentimentExtremity,
          factualRatio: totalAllSegments > 0 ? factualCount / totalAllSegments : 0,
        };

        // Grounding uses checkableTotal (excludes Not Checkable/OTHER)
        const scoreInputs = { supported, contradicted, mixed, unknown, total: checkableTotal };
        const scores = computePersistedScores(scoreInputs, sourcingInputs, oneSidednessInputs, claimGroundingInputs);

        const { error: updateErr } = await supabase
          .from("documents")
          .update({
            strip,
            grounding_score: scores.groundingScore,
            integrity_score: scores.integrityScore,
            sourcing_quality: scores.sourcingQuality,
            one_sidedness: scores.oneSidedness,
            factuality_score: scores.factualityScore,
          })
          .eq("id", doc.id);

        if (updateErr) {
          errors.push(`Doc ${doc.id}: update failed: ${updateErr.message}`);
        } else {
          totalAggregated++;
          console.log(
            `Doc ${doc.id}: strip=${strip.length}, grounding=${scores.groundingScore}, integrity=${scores.integrityScore}, sourcing=${scores.sourcingQuality}, onesided=${scores.oneSidedness}, factuality=${scores.factualityScore}`
          );
        }
      } catch (e) {
        errors.push(`Doc ${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Compute publisher baselines (updated with new metrics)
    const feedIds = [...new Set(docs.map((d) => d.feed_id))];
    const { data: feeds } = await supabase
      .from("feeds")
      .select("id, publisher_name")
      .in("id", feedIds);

    for (const feed of feeds || []) {
      try {
        for (const period of ["7d", "30d"] as const) {
          const daysAgo = period === "7d" ? 7 : 30;
          const since = new Date(Date.now() - daysAgo * 86400000).toISOString();

          const { data: recentDocs } = await supabase
            .from("documents")
            .select("grounding_score, integrity_score, strip, sourcing_quality, one_sidedness, factuality_score, ideology_scores")
            .eq("feed_id", feed.id)
            .not("strip", "is", null)
            .gte("grounding_score", 0)
            .gte("created_at", since);

          if (!recentDocs || recentDocs.length === 0) continue;

          const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

          const avgGrounding = avg(recentDocs.map((d) => d.grounding_score || 0));
          const avgIntegrity = avg(recentDocs.map((d) => d.integrity_score || 0));
          const avgSourcing = avg(recentDocs.filter((d) => d.sourcing_quality != null).map((d) => d.sourcing_quality!));
          const avgOnesided = avg(recentDocs.filter((d) => d.one_sidedness != null).map((d) => d.one_sidedness!));
          const avgFactuality = avg(recentDocs.filter((d) => d.factuality_score != null).map((d) => d.factuality_score!));

          // Ideology averages
          const ideologyDocs = recentDocs.filter((d) => d.ideology_scores && typeof d.ideology_scores === "object");
          const avgEconomic = avg(ideologyDocs.map((d) => (d.ideology_scores as any).economic));
          const avgSocial = avg(ideologyDocs.map((d) => (d.ideology_scores as any).social));

          const labelDist: Record<string, number> = {};
          let totalCells = 0;
          for (const d of recentDocs) {
            const cells = (d.strip as { label: string }[]) || [];
            for (const cell of cells) {
              labelDist[cell.label] = (labelDist[cell.label] || 0) + 1;
              totalCells++;
            }
          }

          const normalizedDist: Record<string, number> = {};
          for (const [label, count] of Object.entries(labelDist)) {
            normalizedDist[label] = Math.round((count / totalCells) * 1000) / 1000;
          }

          const avgContradiction = normalizedDist["CONTRADICTED"] || 0;

          const { data: existing } = await supabase
            .from("publisher_baselines")
            .select("id")
            .eq("publisher_name", feed.publisher_name)
            .eq("period", period)
            .limit(1);

          const baselineData = {
            avg_grounding_score: avgGrounding,
            avg_integrity_score: avgIntegrity,
            avg_contradiction_rate: avgContradiction,
            segment_label_distribution: normalizedDist,
            document_count: recentDocs.length,
            computed_at: new Date().toISOString(),
            avg_sourcing_quality: avgSourcing,
            avg_one_sidedness: avgOnesided,
            avg_factuality_score: avgFactuality,
            avg_ideology_economic: avgEconomic,
            avg_ideology_social: avgSocial,
          };

          if (existing && existing.length > 0) {
            await supabase
              .from("publisher_baselines")
              .update(baselineData)
              .eq("id", existing[0].id);
          } else {
            await supabase.from("publisher_baselines").insert({
              publisher_name: feed.publisher_name,
              period,
              ...baselineData,
            });
          }
        }
      } catch (e) {
        errors.push(`Baseline ${feed.publisher_name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log(`Aggregator complete: ${totalAggregated} documents`);
    if (errors.length) console.warn("Aggregator errors:", errors);

    return new Response(
      JSON.stringify({
        aggregated: totalAggregated,
        errors: errors.length ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Aggregator fatal error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
