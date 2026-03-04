# Graphile Worker (Step 1 Scaffold)

This directory contains a **non-production scaffold** for introducing Graphile Worker incrementally.

## Purpose

- Provide an always-on Node worker skeleton.
- Keep current Supabase `pgmq` + `pipeline-worker` orchestration unchanged.
- Enable shadow-mode experimentation before stage ownership cutover.

## Current state

- Includes only scaffold tasks:
  - `ops.noop`
  - `pipeline.shadow_sentiment`
- No existing queue routing is modified.
- No production jobs are enqueued here yet.

## Local run

```bash
npm --prefix worker install
GRAPHILE_DATABASE_URL=postgres://... npm --prefix worker run dev
```

Optional env vars:

- `GRAPHILE_DATABASE_URL` (preferred)
- `DATABASE_URL` (fallback)
- `GRAPHILE_CONCURRENCY` (default: `5`)

Required for `pipeline.shadow_sentiment`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Next steps (Step 2+)

1. Add per-stage owner config (`pgmq` vs `graphile`).
2. Shadow-enqueue one stage (`SENTIMENT`).
3. Validate parity and reliability metrics.
4. Cut over stage-by-stage with instant rollback.
