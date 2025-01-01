#!/usr/bin/env node

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUNS = Number(process.env.RUNS || 5);
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 30);

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  process.exit(1);
}

async function runOnce(index) {
  const started = Date.now();
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/pipeline-worker`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ max_messages: MAX_MESSAGES }),
  });

  const body = await resp.json().catch(() => ({}));
  const elapsedMs = Date.now() - started;

  return {
    index,
    ok: resp.ok,
    status: resp.status,
    elapsedMs,
    processed: body.processed ?? 0,
    failed: body.failed ?? 0,
    skipped: body.skipped ?? 0,
    deferred: body.deferred ?? 0,
    totalRead: body.total_read ?? 0,
    cycles: body.cycles ?? 0,
    finalQty: body.final_qty ?? null,
    finalConcurrency: body.final_concurrency ?? null,
  };
}

const rows = [];
for (let i = 1; i <= RUNS; i++) {
  // eslint-disable-next-line no-await-in-loop
  const row = await runOnce(i);
  rows.push(row);
  console.log(
    `run=${row.index} status=${row.status} t=${row.elapsedMs}ms read=${row.totalRead} processed=${row.processed} failed=${row.failed} cycles=${row.cycles}`,
  );
}

const totalProcessed = rows.reduce((sum, r) => sum + r.processed, 0);
const totalRead = rows.reduce((sum, r) => sum + r.totalRead, 0);
const totalFailed = rows.reduce((sum, r) => sum + r.failed, 0);
const totalMs = rows.reduce((sum, r) => sum + r.elapsedMs, 0);

console.log("\n=== queue-load-test summary ===");
console.log(`runs=${RUNS}`);
console.log(`read=${totalRead} processed=${totalProcessed} failed=${totalFailed}`);
console.log(`avg_latency_ms=${Math.round(totalMs / Math.max(1, RUNS))}`);
console.log(`processed_per_sec=${(totalProcessed / Math.max(1, totalMs / 1000)).toFixed(2)}`);
