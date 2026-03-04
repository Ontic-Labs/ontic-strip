-- Step 3 activation: enable Graphile shadow mode for SENTIMENT.
-- Primary orchestration remains pgmq; this only enables additional shadow enqueue.

INSERT INTO public.pipeline_stage_ownership (stage, owner)
VALUES ('SENTIMENT', 'graphile')
ON CONFLICT (stage)
DO UPDATE SET owner = EXCLUDED.owner;
