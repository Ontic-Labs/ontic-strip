-- Step 6: Full Graphile stage routing cutover.
-- Routes enqueue through stage ownership, defaults to Graphile for all pipeline stages,
-- and keeps pgmq fallback behavior if Graphile schema/functions are unavailable.

CREATE OR REPLACE FUNCTION public.enqueue_graphile_stage_job(
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
  BEGIN
    EXECUTE 'SELECT graphile_worker.add_job($1, $2::jsonb)'
      USING
        'pipeline.run_stage',
        jsonb_build_object(
          'document_id', p_doc_id,
          'stage', upper(p_stage),
          'status_token', p_status_token,
          'attempt', p_attempt,
          'source', 'supabase_enqueue'
        );

    RETURN true;
  EXCEPTION
    WHEN undefined_function OR undefined_table OR invalid_schema_name THEN
      RAISE NOTICE 'Graphile enqueue unavailable (schema/function missing), falling back to pgmq';
      RETURN false;
  END;
END;
$$;

COMMENT ON FUNCTION public.enqueue_graphile_stage_job(uuid, text, text, integer) IS
  'Enqueue pipeline.run_stage in Graphile Worker for any pipeline stage.';

CREATE OR REPLACE FUNCTION public.enqueue_stage_if_new(
  p_doc_id uuid,
  p_stage text,
  p_status_token text,
  p_attempt integer DEFAULT 1
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pgmq
AS $$
DECLARE
  inserted_rows integer;
  stage_owner text;
  graphile_enqueued boolean;
BEGIN
  INSERT INTO public.pipeline_enqueue_guard (doc_id, stage, status_token)
  VALUES (p_doc_id, upper(p_stage), p_status_token)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS inserted_rows = ROW_COUNT;

  IF inserted_rows <> 1 THEN
    RETURN false;
  END IF;

  stage_owner := public.pipeline_stage_owner(upper(p_stage));

  IF stage_owner = 'graphile' THEN
    graphile_enqueued := public.enqueue_graphile_stage_job(p_doc_id, upper(p_stage), p_status_token, p_attempt);
    IF graphile_enqueued THEN
      RETURN true;
    END IF;
  END IF;

  PERFORM pgmq.send('pipeline_jobs', jsonb_build_object(
    'doc_id', p_doc_id,
    'stage', upper(p_stage),
    'attempt', p_attempt
  ));

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_pipeline_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pgmq
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
  END IF;

  RETURN NEW;
END;
$$;

-- Cut over all known stages to Graphile ownership.
UPDATE public.pipeline_stage_ownership
SET owner = 'graphile', updated_at = now()
WHERE stage IN (
  'NORMALIZE',
  'INDEX',
  'CLASSIFY',
  'EXTRACT',
  'EVIDENCE',
  'VERACITY',
  'AGGREGATE',
  'SENTIMENT',
  'SYNTHESIS',
  'IDEOLOGY',
  'ENRICH'
);
