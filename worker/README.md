# Graphile Worker

This directory contains the Graphile Worker runtime for pipeline stage orchestration.

## Purpose

- Provide an always-on Node.js worker for pipeline job execution.
- Execute stage jobs via `pipeline.run_stage` and invoke existing Supabase Edge Functions.

## Current state

- Single task: `pipeline.run_stage` (handles all 11 pipeline stages).
- Per-stage retry limits, idempotency guards, pause support, and DLQ routing.
- All enqueue paths route exclusively through Graphile Worker.

## Local run

```bash
npm --prefix worker install
GRAPHILE_DATABASE_URL=postgres://... npm --prefix worker run dev
```

Optional env vars:

- `GRAPHILE_DATABASE_URL` (preferred)
- `DATABASE_URL` (fallback)
- `GRAPHILE_CONCURRENCY` (default: `5`)

Required for stage execution:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Notes

- `pipeline.run_stage` reuses existing Supabase Edge Functions (`normalizer`, `indexer`, `oracle-*`, etc.).
- Retry behavior is handled by per-stage attempt limits and explicit re-enqueue in worker logic.
- Failed jobs exceeding max attempts are routed to the `pipeline_dlq` table.
