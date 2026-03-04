-- Step 3: Shadow enqueue SENTIMENT to Graphile Worker behind owner toggle.
-- Safety: Existing pgmq enqueue path remains unchanged.
-- Effective behavior with defaults: no change (owner defaults to 'pgmq').

CREATE OR REPLACE FUNCTION public.enqueue_graphile_shadow_job(
  p_doc_id uuid,
  p_stage text,
  p_status_token text,
  p_attempt integer DEFAULT 1
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  -- Step 3 scope: shadow only SENTIMENT jobs.
  IF upper(p_stage) <> 'SENTIMENT' THEN
    RETURN false;
  END IF;

  -- Only shadow when owner is explicitly set to graphile.
  IF public.pipeline_stage_owner('SENTIMENT') <> 'graphile' THEN
    RETURN false;
  END IF;

  BEGIN
    EXECUTE 'SELECT graphile_worker.add_job($1, $2::jsonb)'
      USING
        'pipeline.shadow_sentiment',
        jsonb_build_object(
          'document_id', p_doc_id,
          'stage', upper(p_stage),
          'status_token', p_status_token,
          'attempt', p_attempt,
          'source', 'supabase_pgmq_shadow'
        );

    RETURN true;
  EXCEPTION
    WHEN undefined_function OR undefined_table OR invalid_schema_name THEN
      -- Graphile schema may not exist yet in early rollout; keep pgmq path untouched.
      RAISE NOTICE 'Graphile shadow enqueue unavailable (schema/function missing), continuing with pgmq';
      RETURN false;
  END;
END;
$$;

COMMENT ON FUNCTION public.enqueue_graphile_shadow_job(uuid, text, text, integer) IS
  'Step 3 shadow enqueue for SENTIMENT into graphile_worker.add_job when owner=graphile; pgmq path remains primary.';

CREATE OR REPLACE FUNCTION public.enqueue_pipeline_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pgmq'
AS $$
DECLARE
  stage text;
  token text;
BEGIN
  IF OLD.pipeline_status IS NOT DISTINCT FROM NEW.pipeline_status THEN
    RETURN NEW;
  END IF;

  token := NEW.pipeline_status;
  stage := pipeline_status_to_stage(NEW.pipeline_status);

  IF stage IS NOT NULL THEN
    PERFORM public.enqueue_stage_if_new(NEW.id, stage, token, 1);
  END IF;

  IF NEW.pipeline_status = 'verifying' THEN
    PERFORM public.enqueue_stage_if_new(NEW.id, 'VERACITY', token, 1);
  END IF;

  IF NEW.pipeline_status = 'aggregated' THEN
    PERFORM public.enqueue_stage_if_new(NEW.id, 'SENTIMENT', token, 1);
    PERFORM public.enqueue_stage_if_new(NEW.id, 'SYNTHESIS', token, 1);
    PERFORM public.enqueue_stage_if_new(NEW.id, 'IDEOLOGY', token, 1);
    PERFORM public.enqueue_stage_if_new(NEW.id, 'ENRICH', token, 1);

    -- Shadow mode for Graphile pilot: SENTIMENT only, behind owner toggle.
    PERFORM public.enqueue_graphile_shadow_job(NEW.id, 'SENTIMENT', token, 1);
  END IF;

  RETURN NEW;
END;
$$;
