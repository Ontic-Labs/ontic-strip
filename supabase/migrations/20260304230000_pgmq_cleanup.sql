-- Step 8: Clean up pgmq artefacts after hard cutover.
--
-- * Drop the public-facing pgmq RPC wrappers (pgmq_send, pgmq_read, pgmq_archive).
--   The underlying pgmq extension remains installed but no application code
--   references it any more.
-- * Drop the shadow sentiment tooling (enqueue_graphile_shadow_job, shadow tables/views).
-- * Remove the pipeline_stage_ownership table and helper now that all stages
--   are permanently on Graphile.

-- 8a. Drop pgmq RPC wrappers.
DROP FUNCTION IF EXISTS public.pgmq_send(text, jsonb);
DROP FUNCTION IF EXISTS public.pgmq_read(text, integer, integer);
DROP FUNCTION IF EXISTS public.pgmq_archive(text, bigint);

-- 8b. Drop shadow parity tooling (no longer needed post-cutover).
-- Clean up any leftover shadow jobs so the worker never encounters unknown-task rows.
DELETE FROM graphile_worker.jobs
WHERE task_identifier = 'pipeline.shadow_sentiment';

DROP FUNCTION IF EXISTS public.enqueue_graphile_shadow_job(uuid, text, text, integer);
DROP VIEW IF EXISTS public.graphile_shadow_stage_daily;
DROP TABLE IF EXISTS public.graphile_shadow_runs;

-- 8c. Drop pipeline_stage_ownership config (everything is Graphile now).
DROP FUNCTION IF EXISTS public.pipeline_stage_owner(text);
DROP TABLE IF EXISTS public.pipeline_stage_ownership;
