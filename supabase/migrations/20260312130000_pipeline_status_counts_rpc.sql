-- Returns pipeline_status counts as JSONB, e.g. {"pending": 12, "aggregated": 340, ...}
-- Replaces the client-side full-table scan in JobHealth with a single indexed GROUP BY.
CREATE OR REPLACE FUNCTION public.pipeline_status_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT coalesce(
    jsonb_object_agg(pipeline_status, cnt),
    '{}'::jsonb
  )
  FROM (
    SELECT pipeline_status, count(*) AS cnt
    FROM public.documents
    GROUP BY pipeline_status
  ) t;
$$;
