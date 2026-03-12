-- Fix three compounding bugs that caused 473+ documents to get stuck at
-- pipeline_status='normalizing' with no Graphile jobs queued.
--
-- BUG 1: trg_pipeline_enqueue fires only on UPDATE, not INSERT.
--   When rss-collector/collector INSERTs a new doc with status 'normalizing',
--   the trigger never fires.  The only enqueue path was the explicit
--   supabase.rpc() call in the edge function, which could silently fail.
--
-- BUG 2: Two overloads of enqueue_graphile_stage_job (4-param and 5-param)
--   cause PostgREST 300 "Multiple Choices" ambiguity when edge functions
--   call the RPC with named parameters.
--
-- BUG 3: Migration 20260312140000 changed $2::json to $2::jsonb in
--   enqueue_graphile_stage_job, but graphile_worker.add_job expects json.
--   This caused ALL enqueue attempts to silently fail.
--
-- FIX 1: Change trigger to AFTER INSERT OR UPDATE.
-- FIX 2: Drop the old 4-param overload, keep only the 5-param version.
-- FIX 3: Fix jsonb→json cast in enqueue_graphile_stage_job.
-- FIX 4: Re-enqueue all stuck normalizing + pending docs.

BEGIN;

-- ============================================================
-- FIX 1: Trigger fires on INSERT OR UPDATE
-- ============================================================
DROP TRIGGER IF EXISTS trg_pipeline_enqueue ON public.documents;

CREATE TRIGGER trg_pipeline_enqueue
  AFTER INSERT OR UPDATE OF pipeline_status ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_pipeline_stage();

COMMENT ON TRIGGER trg_pipeline_enqueue ON public.documents IS
  'Enqueue Graphile job on INSERT (new doc) or UPDATE of pipeline_status (stage transition).';

-- ============================================================
-- FIX 2: Drop ambiguous 4-param overload
-- ============================================================
-- The 5-param version (with p_run_at DEFAULT NULL) already covers
-- all callers.  Dropping the 4-param eliminates PostgREST ambiguity.

-- First update enqueue_stage_if_new to use explicit 5-param call
-- so PG doesn't complain about the missing function.
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
    p_doc_id, upper(p_stage), p_status_token, p_attempt, NULL::timestamptz
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

-- Also update enqueue_stuck_docs to use explicit 5-param call
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
      doc.id, upper(target_stage), target_status, 1, NULL::timestamptz
    );
    IF enqueued THEN
      cnt := cnt + 1;
    END IF;
  END LOOP;
  RETURN cnt;
END;
$$;

-- Now safe to drop the old 4-param overload
DROP FUNCTION IF EXISTS public.enqueue_graphile_stage_job(uuid, text, text, integer);

-- ============================================================
-- FIX 3: Fix jsonb→json cast in enqueue_graphile_stage_job
-- ============================================================
-- graphile_worker.add_job expects (text, json, ...) not (text, jsonb, ...).
-- The 20260312140000 migration changed $2::json to $2::jsonb, breaking enqueue.
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
      EXECUTE 'SELECT graphile_worker.add_job($1, $2::json, run_at := $3)'
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
      EXECUTE 'SELECT graphile_worker.add_job($1, $2::json)'
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

-- ============================================================
-- FIX 4: Re-enqueue all stuck normalizing and pending docs
-- ============================================================
-- Clear any stale NORMALIZE guard rows first (there shouldn't be any,
-- but be safe), then enqueue every normalizing doc.
DELETE FROM public.pipeline_enqueue_guard WHERE stage = 'NORMALIZE';

-- Enqueue all normalizing docs (no 50-row limit like enqueue_stuck_docs)
DO $$
DECLARE
  doc RECORD;
  enqueued boolean;
  cnt integer := 0;
BEGIN
  FOR doc IN
    SELECT id FROM public.documents
    WHERE pipeline_status = 'normalizing'
    ORDER BY created_at ASC
  LOOP
    -- Insert guard row
    INSERT INTO public.pipeline_enqueue_guard (doc_id, stage, status_token)
    VALUES (doc.id, 'NORMALIZE', 'normalizing')
    ON CONFLICT DO NOTHING;

    -- Enqueue the job
    enqueued := public.enqueue_graphile_stage_job(
      doc.id, 'NORMALIZE', 'normalizing', 1, NULL::timestamptz
    );

    IF enqueued THEN
      cnt := cnt + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'Re-enqueued % stuck normalizing documents', cnt;
END;
$$;

-- Also re-enqueue pending docs if any are stuck
DO $$
DECLARE
  doc RECORD;
  enqueued boolean;
  cnt integer := 0;
BEGIN
  FOR doc IN
    SELECT id FROM public.documents
    WHERE pipeline_status = 'pending'
    ORDER BY created_at ASC
  LOOP
    INSERT INTO public.pipeline_enqueue_guard (doc_id, stage, status_token)
    VALUES (doc.id, 'INDEX', 'pending')
    ON CONFLICT DO NOTHING;

    enqueued := public.enqueue_graphile_stage_job(
      doc.id, 'INDEX', 'pending', 1, NULL::timestamptz
    );

    IF enqueued THEN
      cnt := cnt + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'Re-enqueued % stuck pending documents', cnt;
END;
$$;

COMMIT;
