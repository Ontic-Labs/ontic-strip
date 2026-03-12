-- Returns per-feed document counts grouped by pipeline_status as JSONB.
-- e.g. [{"feed_id": "abc", "status": "aggregated", "cnt": 42}, ...]
-- Replaces client-side full documents table scan in the health page.
CREATE OR REPLACE FUNCTION public.feed_doc_status_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  FROM (
    SELECT
      feed_id,
      coalesce(pipeline_status, 'unknown') AS status,
      count(*) AS cnt
    FROM public.documents
    WHERE feed_id IS NOT NULL
    GROUP BY feed_id, pipeline_status
  ) t;
$$;
