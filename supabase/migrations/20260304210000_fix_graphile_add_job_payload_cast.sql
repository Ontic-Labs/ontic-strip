-- Step 6b: Fix Graphile add_job payload casting for installed function signatures.

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
    EXECUTE 'SELECT graphile_worker.add_job($1, $2::json)'
      USING
        'pipeline.run_stage',
        json_build_object(
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
  IF upper(p_stage) <> 'SENTIMENT' THEN
    RETURN false;
  END IF;

  IF public.pipeline_stage_owner('SENTIMENT') <> 'graphile' THEN
    RETURN false;
  END IF;

  BEGIN
    EXECUTE 'SELECT graphile_worker.add_job($1, $2::json)'
      USING
        'pipeline.shadow_sentiment',
        json_build_object(
          'document_id', p_doc_id,
          'stage', upper(p_stage),
          'status_token', p_status_token,
          'attempt', p_attempt,
          'source', 'supabase_pgmq_shadow'
        );

    RETURN true;
  EXCEPTION
    WHEN undefined_function OR undefined_table OR invalid_schema_name THEN
      RAISE NOTICE 'Graphile shadow enqueue unavailable (schema/function missing), continuing with pgmq';
      RETURN false;
  END;
END;
$$;
