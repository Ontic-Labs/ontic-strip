# Graphile Worker

This directory contains the Graphile Worker runtime for pipeline stage orchestration.

## Purpose

- Provide an always-on Node worker for pipeline execution.
- Execute stage jobs via `pipeline.run_stage` and invoke existing Supabase Edge Functions.
- Support per-stage routing through `pipeline_stage_ownership`.

## Current state

- Includes tasks:
  - `pipeline.run_stage` (primary)
  - `pipeline.shadow_sentiment` (compatibility alias)
- Stage routing is controlled in SQL (`pipeline_stage_ownership`).

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
- Retry behavior is handled by stage attempt limits and explicit re-enqueue in worker logic.
- If Graphile enqueue is unavailable, SQL routing falls back to `pgmq`.
