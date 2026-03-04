#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STAGE = (process.env.STAGE || "SENTIMENT").toUpperCase();
const DAYS = Number(process.env.DAYS || 1);

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  process.exit(1);
}

if (!Number.isFinite(DAYS) || DAYS <= 0) {
  console.error("DAYS must be a positive number");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const sinceIso = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function summarize(rows) {
  const total = rows.length;
  const ok = rows.filter((r) => r.status === "ok").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const failRate = total ? (failed / total) * 100 : 0;
  const durations = rows
    .map((r) => r.duration_ms)
    .filter((n) => typeof n === "number" && Number.isFinite(n));

  return {
    total,
    ok,
    failed,
    failRate,
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    avg: durations.length
      ? Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length)
      : null,
  };
}

function latestByDocument(rows) {
  const byDoc = new Map();
  for (const row of rows) {
    const documentId = row.document_id;
    if (!documentId) continue;
    const previous = byDoc.get(documentId);
    if (!previous || previous.created_at < row.created_at) {
      byDoc.set(documentId, row);
    }
  }
  return byDoc;
}

function printSummary(label, summary) {
  console.log(`\n${label}`);
  console.log(`  total:     ${summary.total}`);
  console.log(`  ok:        ${summary.ok}`);
  console.log(`  failed:    ${summary.failed}`);
  console.log(`  fail_rate: ${summary.failRate.toFixed(2)}%`);
  console.log(`  avg_ms:    ${summary.avg ?? "n/a"}`);
  console.log(`  p50_ms:    ${summary.p50 ?? "n/a"}`);
  console.log(`  p95_ms:    ${summary.p95 ?? "n/a"}`);
}

async function main() {
  const { data: pgmqRows, error: pgmqErr } = await supabase
    .from("pipeline_stage_metrics")
    .select("document_id, status, duration_ms, created_at")
    .eq("stage", STAGE)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });

  if (pgmqErr) {
    throw new Error(`Failed to read pipeline_stage_metrics: ${pgmqErr.message}`);
  }

  const { data: shadowRows, error: shadowErr } = await supabase
    .from("graphile_shadow_runs")
    .select("document_id, status, duration_ms, created_at")
    .eq("stage", STAGE)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });

  if (shadowErr) {
    throw new Error(`Failed to read graphile_shadow_runs: ${shadowErr.message}`);
  }

  const pgmq = pgmqRows || [];
  const shadow = shadowRows || [];

  const pgmqSummary = summarize(pgmq);
  const shadowSummary = summarize(shadow);

  console.log(`\n=== Shadow Parity Report (${STAGE}) ===`);
  console.log(`window_start: ${sinceIso}`);
  console.log(`window_days:  ${DAYS}`);

  printSummary("PGMQ", pgmqSummary);
  printSummary("Graphile Shadow", shadowSummary);

  const pgmqLatest = latestByDocument(pgmq);
  const shadowLatest = latestByDocument(shadow);

  let overlap = 0;
  let sameStatus = 0;

  for (const [documentId, pgmqRun] of pgmqLatest) {
    const shadowRun = shadowLatest.get(documentId);
    if (!shadowRun) continue;
    overlap += 1;
    if (shadowRun.status === pgmqRun.status) {
      sameStatus += 1;
    }
  }

  const agreementPct = overlap ? (sameStatus / overlap) * 100 : 0;

  console.log("\nOverlap");
  console.log(`  pgmq_docs:          ${pgmqLatest.size}`);
  console.log(`  shadow_docs:        ${shadowLatest.size}`);
  console.log(`  overlapping_docs:   ${overlap}`);
  console.log(`  status_agreement:   ${sameStatus}/${overlap} (${agreementPct.toFixed(2)}%)`);
}

main().catch((error) => {
  console.error("\n[shadow-parity] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
