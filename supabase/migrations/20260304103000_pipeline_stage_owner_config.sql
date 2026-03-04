-- Step 2: Stage ownership config scaffold
-- Purpose: Introduce per-stage routing ownership (`pgmq` | `graphile`) with safe defaults.
-- Behavior change: None yet. Existing enqueue logic remains unchanged until later cutover steps.

CREATE TABLE IF NOT EXISTS public.pipeline_stage_ownership (
  stage text PRIMARY KEY,
  owner text NOT NULL DEFAULT 'pgmq',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_stage_ownership_owner_check CHECK (owner IN ('pgmq', 'graphile'))
);

ALTER TABLE public.pipeline_stage_ownership ENABLE ROW LEVEL SECURITY;

-- Service role manages routing config; anon/authenticated can read for observability.
DROP POLICY IF EXISTS "pipeline_stage_ownership_select_all" ON public.pipeline_stage_ownership;
CREATE POLICY "pipeline_stage_ownership_select_all"
  ON public.pipeline_stage_ownership
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "pipeline_stage_ownership_service_manage" ON public.pipeline_stage_ownership;
CREATE POLICY "pipeline_stage_ownership_service_manage"
  ON public.pipeline_stage_ownership
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON TABLE public.pipeline_stage_ownership TO anon;
GRANT SELECT ON TABLE public.pipeline_stage_ownership TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pipeline_stage_ownership TO service_role;

DROP TRIGGER IF EXISTS trg_pipeline_stage_ownership_updated_at ON public.pipeline_stage_ownership;
CREATE TRIGGER trg_pipeline_stage_ownership_updated_at
BEFORE UPDATE ON public.pipeline_stage_ownership
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Seed known pipeline stages with default owner=pgmq.
INSERT INTO public.pipeline_stage_ownership (stage, owner)
VALUES
  ('NORMALIZE', 'pgmq'),
  ('INDEX', 'pgmq'),
  ('CLASSIFY', 'pgmq'),
  ('EXTRACT', 'pgmq'),
  ('EVIDENCE', 'pgmq'),
  ('VERACITY', 'pgmq'),
  ('AGGREGATE', 'pgmq'),
  ('SENTIMENT', 'pgmq'),
  ('SYNTHESIS', 'pgmq'),
  ('IDEOLOGY', 'pgmq'),
  ('ENRICH', 'pgmq')
ON CONFLICT (stage) DO UPDATE
SET owner = EXCLUDED.owner;

CREATE OR REPLACE FUNCTION public.pipeline_stage_owner(p_stage text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT COALESCE(
    (SELECT owner FROM public.pipeline_stage_ownership WHERE stage = upper(p_stage)),
    'pgmq'
  );
$$;

COMMENT ON TABLE public.pipeline_stage_ownership IS
  'Per-stage orchestration ownership toggle. Step 2 scaffold; defaults to pgmq.';

COMMENT ON FUNCTION public.pipeline_stage_owner(text) IS
  'Returns the configured owner (pgmq|graphile) for a stage; defaults to pgmq.';
