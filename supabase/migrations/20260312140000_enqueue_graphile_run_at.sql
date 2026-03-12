-- Add optional p_run_at parameter to enqueue_graphile_stage_job so callers
-- can schedule delayed re-enqueue (e.g. paused-stage deferral).
CREATE OR REPLACE FUNCTION public.enqueue_graphile_stage_job(
  p_doc_id uuid,
  p_stage text,
  p_status_token text,
  p_attempt integer DEFAULT 1,
  p_run_at timestamptz DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  BEGIN
    IF p_run_at IS NOT NULL THEN
      EXECUTE 'SELECT graphile_worker.add_job($1, $2::jsonb, run_at := $3)'
        USING
          'pipeline.run_stage',
          jsonb_build_object(
            'document_id', p_doc_id,
            'stage', upper(p_stage),
            'status_token', p_status_token,
            'attempt', p_attempt,
            'source', 'supabase_enqueue'
          ),
          p_run_at;
    ELSE
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
    END IF;

    RETURN true;
  EXCEPTION
    WHEN undefined_function OR undefined_table OR invalid_schema_name THEN
      RAISE NOTICE 'Graphile enqueue unavailable (schema/function missing)';
      RETURN false;
  END;
END;
$$;
