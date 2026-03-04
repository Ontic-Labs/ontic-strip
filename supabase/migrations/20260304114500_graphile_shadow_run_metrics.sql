-- Step 4: Graphile shadow-run observability
-- Captures per-run outcomes for shadow jobs (no effect on primary pgmq flow).

CREATE TABLE IF NOT EXISTS public.graphile_shadow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage text NOT NULL,
  document_id uuid,
  status text NOT NULL,
  http_status integer,
  duration_ms integer,
  source text NOT NULL DEFAULT 'graphile_worker',
  error_message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT graphile_shadow_runs_stage_check CHECK (stage IN (
    'NORMALIZE','INDEX','CLASSIFY','EXTRACT','EVIDENCE','VERACITY','AGGREGATE','SENTIMENT','SYNTHESIS','IDEOLOGY','ENRICH'
  )),
  CONSTRAINT graphile_shadow_runs_status_check CHECK (status IN ('ok', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_graphile_shadow_runs_stage_created_at
  ON public.graphile_shadow_runs(stage, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_graphile_shadow_runs_document_id
  ON public.graphile_shadow_runs(document_id);

ALTER TABLE public.graphile_shadow_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "graphile_shadow_runs_select_all" ON public.graphile_shadow_runs;
CREATE POLICY "graphile_shadow_runs_select_all"
  ON public.graphile_shadow_runs
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "graphile_shadow_runs_service_manage" ON public.graphile_shadow_runs;
CREATE POLICY "graphile_shadow_runs_service_manage"
  ON public.graphile_shadow_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON TABLE public.graphile_shadow_runs TO anon;
GRANT SELECT ON TABLE public.graphile_shadow_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.graphile_shadow_runs TO service_role;

CREATE OR REPLACE VIEW public.graphile_shadow_stage_daily AS
SELECT
  date_trunc('day', created_at) AS day,
  stage,
  count(*) AS total_runs,
  count(*) FILTER (WHERE status = 'ok') AS ok_runs,
  count(*) FILTER (WHERE status = 'failed') AS failed_runs,
  round((count(*) FILTER (WHERE status = 'failed')::numeric / NULLIF(count(*), 0)) * 100, 2) AS failed_pct,
  round(avg(duration_ms)::numeric, 2) AS avg_duration_ms,
  max(created_at) AS last_seen_at
FROM public.graphile_shadow_runs
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

COMMENT ON TABLE public.graphile_shadow_runs IS
  'Per-job run records for Graphile shadow-mode execution (Step 4 parity tracking).';

COMMENT ON VIEW public.graphile_shadow_stage_daily IS
  'Daily reliability and latency rollups for graphile shadow runs by stage.';
