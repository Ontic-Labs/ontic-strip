-- Step 7: Hard cutover – remove pgmq fallback from all enqueue paths.
-- After this migration, all pipeline jobs are routed exclusively through
-- Graphile Worker.  The pgmq queue table is left intact for now (cleanup
-- handled in a separate migration) so we can inspect any stale messages.

-- 7a. enqueue_stage_if_new(): remove pgmq fallback, error on Graphile failure.
CREATE OR REPLACE FUNCTION public.enqueue_stage_if_new(
  p_doc_id uuid,
  p_stage text,
  p_status_token text,
  p_attempt integer DEFAULT 1
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  inserted_rows integer;
  graphile_enqueued boolean;
BEGIN
  INSERT INTO public.pipeline_enqueue_guard (doc_id, stage, status_token)
  VALUES (p_doc_id, upper(p_stage), p_status_token)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS inserted_rows = ROW_COUNT;

  IF inserted_rows <> 1 THEN
    RETURN false;
  END IF;

  graphile_enqueued := public.enqueue_graphile_stage_job(
    p_doc_id, upper(p_stage), p_status_token, p_attempt
  );

  IF NOT graphile_enqueued THEN
    DELETE FROM public.pipeline_enqueue_guard
    WHERE doc_id = p_doc_id
      AND stage = upper(p_stage)
      AND status_token = p_status_token;

    RAISE WARNING 'enqueue_stage_if_new: Graphile enqueue failed for doc=% stage=%',
      p_doc_id, upper(p_stage);
  END IF;

  RETURN graphile_enqueued;
END;
$$;

COMMENT ON FUNCTION public.enqueue_stage_if_new(uuid, text, text, integer) IS
  'Dedup-guarded enqueue via Graphile Worker (pgmq fallback removed).';

-- 7b. enqueue_pipeline_stage() trigger: drop pgmq from search_path.
CREATE OR REPLACE FUNCTION public.enqueue_pipeline_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
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

-- 7c. enqueue_stuck_docs(): route through Graphile instead of pgmq.
CREATE OR REPLACE FUNCTION public.enqueue_stuck_docs(
  target_status text,
  target_stage text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  doc RECORD;
  cnt integer := 0;
  enqueued boolean;
BEGIN
  FOR doc IN
    SELECT id FROM public.documents
    WHERE pipeline_status = target_status
    ORDER BY created_at ASC
    LIMIT 50
  LOOP
    enqueued := public.enqueue_graphile_stage_job(
      doc.id, upper(target_stage), target_status, 1
    );
    IF enqueued THEN
      cnt := cnt + 1;
    END IF;
  END LOOP;
  RETURN cnt;
END;
$$;

COMMENT ON FUNCTION public.enqueue_stuck_docs(text, text) IS
  'Re-enqueue stuck documents via Graphile Worker.';

-- 7d. pipeline_ops_summary(): read queue depth from Graphile Worker jobs table.
CREATE OR REPLACE FUNCTION public.pipeline_ops_summary() RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  queue_depth bigint;
  dlq_count bigint;
  paused_stages jsonb;
  stage_slo jsonb;
BEGIN
  -- Count pending + active Graphile Worker jobs for our task identifier.
  BEGIN
    SELECT count(*) INTO queue_depth
    FROM graphile_worker.jobs
    WHERE task_identifier = 'pipeline.run_stage'
      AND locked_at IS NULL;
  EXCEPTION
    WHEN undefined_table OR invalid_schema_name THEN
      queue_depth := 0;
  END;

  SELECT count(*) INTO dlq_count FROM public.pipeline_dlq;

  SELECT coalesce(jsonb_agg(stage ORDER BY stage), '[]'::jsonb)
    INTO paused_stages
  FROM public.pipeline_control
  WHERE paused = true AND (paused_until IS NULL OR paused_until > now());

  SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.fail_rate DESC NULLS LAST), '[]'::jsonb)
    INTO stage_slo
  FROM (
    SELECT stage, total, ok_count, failed_count, fail_rate, p50_ms, p95_ms
    FROM public.pipeline_stage_metrics_hourly
    WHERE hour_bucket >= date_trunc('hour', now() - interval '1 hour')
  ) t;

  RETURN jsonb_build_object(
    'queue_depth', queue_depth,
    'dlq_count', dlq_count,
    'paused_stages', paused_stages,
    'last_hour', stage_slo
  );
END;
$$;

-- 7e. pipeline_reap_poisoned(): rewrite to scan Graphile permanently_failed jobs.
-- Graphile Worker moves jobs that exceed max_attempts to permanently_failed
-- status.  This function reaps those into our DLQ and removes them.
CREATE OR REPLACE FUNCTION public.pipeline_reap_poisoned(
  p_max_read_ct integer DEFAULT 10,
  p_batch_size integer DEFAULT 200
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  rec record;
  reaped integer := 0;
BEGIN
  -- Scan Graphile Worker jobs table for stuck jobs (ones that have been
  -- retried beyond our application-level max or locked for too long).
  BEGIN
    FOR rec IN
      SELECT id, payload, attempts
      FROM graphile_worker.jobs
      WHERE task_identifier = 'pipeline.run_stage'
        AND attempts >= p_max_read_ct
      ORDER BY id
      LIMIT p_batch_size
    LOOP
      INSERT INTO public.pipeline_dlq (doc_id, stage, attempt, error_message, payload)
      VALUES (
        (rec.payload->>'document_id')::uuid,
        rec.payload->>'stage',
        coalesce((rec.payload->>'attempt')::integer, rec.attempts),
        format('reaped as poison job (graphile attempts=%s)', rec.attempts),
        rec.payload
      );

      DELETE FROM graphile_worker.jobs WHERE id = rec.id;
      reaped := reaped + 1;
    END LOOP;
  EXCEPTION
    WHEN undefined_table OR invalid_schema_name THEN
      -- Graphile schema not available; nothing to reap.
      RETURN 0;
  END;

  RETURN reaped;
END;
$$;

COMMENT ON FUNCTION public.pipeline_reap_poisoned(integer, integer) IS
  'Reap stuck Graphile Worker jobs into pipeline_dlq.';
