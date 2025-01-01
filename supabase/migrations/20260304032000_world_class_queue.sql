


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgmq";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."backfill_rescore_batch"("batch_size" integer DEFAULT 100, "reset_synthesis" boolean DEFAULT true) RETURNS TABLE("doc_id" "uuid", "claim_rows_reset" integer, "document_updated" boolean, "synthesis_reset" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  rec RECORD;
  affected_claims integer;
BEGIN
  FOR rec IN
    SELECT d.id
    FROM public.documents d
    WHERE d.strip IS NOT NULL
       OR d.grounding_score IS NOT NULL
       OR d.integrity_score IS NOT NULL
    ORDER BY d.created_at ASC
    LIMIT GREATEST(batch_size, 1)
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.claims c
    SET
      veracity_label = NULL,
      confidence_score = NULL,
      gap_reason = NULL,
      conflict_basis = NULL
    WHERE c.document_id = rec.id;

    GET DIAGNOSTICS affected_claims = ROW_COUNT;

    IF reset_synthesis THEN
      UPDATE public.documents d
      SET
        strip = NULL,
        grounding_score = NULL,
        integrity_score = NULL,
        synthesis_text = NULL,
        synthesis_sources = NULL,
        pipeline_status = 'verifying',
        updated_at = now()
      WHERE d.id = rec.id;
    ELSE
      UPDATE public.documents d
      SET
        strip = NULL,
        grounding_score = NULL,
        integrity_score = NULL,
        pipeline_status = 'verifying',
        updated_at = now()
      WHERE d.id = rec.id;
    END IF;

    doc_id := rec.id;
    claim_rows_reset := affected_claims;
    document_updated := true;
    synthesis_reset := reset_synthesis;
    RETURN NEXT;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."backfill_rescore_batch"("batch_size" integer, "reset_synthesis" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_pipeline_stage"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pgmq'
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


ALTER FUNCTION "public"."enqueue_pipeline_stage"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_stage_if_new"("p_doc_id" "uuid", "p_stage" "text", "p_status_token" "text", "p_attempt" integer DEFAULT 1) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pgmq'
    AS $$
DECLARE
  inserted_rows integer;
BEGIN
  INSERT INTO public.pipeline_enqueue_guard (doc_id, stage, status_token)
  VALUES (p_doc_id, p_stage, p_status_token)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS inserted_rows = ROW_COUNT;

  IF inserted_rows = 1 THEN
    PERFORM pgmq.send('pipeline_jobs', jsonb_build_object(
      'doc_id', p_doc_id,
      'stage', p_stage,
      'attempt', p_attempt
    ));
    RETURN true;
  END IF;

  RETURN false;
END;
$$;


ALTER FUNCTION "public"."enqueue_stage_if_new"("p_doc_id" "uuid", "p_stage" "text", "p_status_token" "text", "p_attempt" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_stuck_docs"("target_status" "text", "target_stage" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pgmq'
    AS $$
DECLARE
  doc RECORD;
  cnt integer := 0;
BEGIN
  FOR doc IN
    SELECT id FROM public.documents
    WHERE pipeline_status = target_status
    ORDER BY created_at ASC
    LIMIT 50
  LOOP
    PERFORM pgmq.send('pipeline_jobs', jsonb_build_object(
      'doc_id', doc.id,
      'stage', target_stage,
      'attempt', 1
    ));
    cnt := cnt + 1;
  END LOOP;
  RETURN cnt;
END;
$$;


ALTER FUNCTION "public"."enqueue_stuck_docs"("target_status" "text", "target_stage" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_event_centroids"("query_embedding" "extensions"."vector", "time_start" timestamp with time zone DEFAULT NULL::timestamp with time zone, "time_end" timestamp with time zone DEFAULT NULL::timestamp with time zone, "match_count" integer DEFAULT 50, "match_threshold" double precision DEFAULT 0.5) RETURNS TABLE("event_id" "uuid", "event_key" "text", "entities" "text"[], "geo_primary" "text", "event_type" "text", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'extensions'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id AS event_id,
    e.event_key,
    e.cluster_entities AS entities,
    e.geo_primary,
    e.event_type,
    (1 - (e.doc_centroid <=> query_embedding))::float AS similarity
  FROM public.events e
  WHERE e.doc_centroid IS NOT NULL
    AND (time_start IS NULL OR e.time_bucket >= time_start)
    AND (time_end IS NULL OR e.time_bucket <= time_end)
    AND (1 - (e.doc_centroid <=> query_embedding))::float > match_threshold
  ORDER BY e.doc_centroid <=> query_embedding
  LIMIT match_count;
END;
$$;


ALTER FUNCTION "public"."match_event_centroids"("query_embedding" "extensions"."vector", "time_start" timestamp with time zone, "time_end" timestamp with time zone, "match_count" integer, "match_threshold" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_segments"("query_embedding" "extensions"."vector", "match_threshold" double precision DEFAULT 0.5, "match_count" integer DEFAULT 10, "exclude_document_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "document_id" "uuid", "text_content" "text", "position_index" integer, "label" "text", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'extensions'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.document_id,
    s.text_content,
    s.position_index,
    s.label,
    (1 - (s.embedding <=> query_embedding))::float AS similarity
  FROM public.segments s
  WHERE s.embedding IS NOT NULL
    AND (exclude_document_id IS NULL OR s.document_id != exclude_document_id)
    AND (1 - (s.embedding <=> query_embedding))::float > match_threshold
  ORDER BY s.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


ALTER FUNCTION "public"."match_segments"("query_embedding" "extensions"."vector", "match_threshold" double precision, "match_count" integer, "exclude_document_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pgmq_archive"("queue_name" "text", "msg_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pgmq', 'public'
    AS $$
BEGIN
  RETURN pgmq.archive(queue_name, msg_id);
END;
$$;


ALTER FUNCTION "public"."pgmq_archive"("queue_name" "text", "msg_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pgmq_read"("queue_name" "text", "vt" integer, "qty" integer) RETURNS TABLE("msg_id" bigint, "read_ct" integer, "enqueued_at" timestamp with time zone, "visible_at" timestamp with time zone, "message" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pgmq', 'public'
    AS $$
BEGIN
  RETURN QUERY SELECT r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message
    FROM pgmq.read(queue_name, vt, qty) r;
END;
$$;


ALTER FUNCTION "public"."pgmq_read"("queue_name" "text", "vt" integer, "qty" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pgmq_send"("queue_name" "text", "msg" "jsonb") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pgmq', 'public'
    AS $$
BEGIN
  RETURN pgmq.send(queue_name, msg);
END;
$$;


ALTER FUNCTION "public"."pgmq_send"("queue_name" "text", "msg" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pipeline_ops_summary"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pgmq'
    AS $$
DECLARE
  queue_depth bigint;
  dlq_count bigint;
  paused_stages jsonb;
  stage_slo jsonb;
BEGIN
  SELECT count(*) INTO queue_depth FROM pgmq.q_pipeline_jobs;
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


ALTER FUNCTION "public"."pipeline_ops_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pipeline_reap_poisoned"("p_max_read_ct" integer DEFAULT 10, "p_batch_size" integer DEFAULT 200) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pgmq'
    AS $$
DECLARE
  rec record;
  reaped integer := 0;
BEGIN
  FOR rec IN
    SELECT msg_id, message, read_ct
    FROM pgmq.q_pipeline_jobs
    WHERE read_ct >= p_max_read_ct
    ORDER BY msg_id
    LIMIT p_batch_size
  LOOP
    INSERT INTO public.pipeline_dlq (doc_id, stage, attempt, error_message, payload)
    VALUES (
      (rec.message->>'doc_id')::uuid,
      rec.message->>'stage',
      coalesce((rec.message->>'attempt')::integer, rec.read_ct),
      format('reaped as poison message (read_ct=%s)', rec.read_ct),
      rec.message
    );

    PERFORM pgmq.archive('pipeline_jobs', rec.msg_id);
    reaped := reaped + 1;
  END LOOP;

  RETURN reaped;
END;
$$;


ALTER FUNCTION "public"."pipeline_reap_poisoned"("p_max_read_ct" integer, "p_batch_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pipeline_record_stage_metric"("p_document_id" "uuid", "p_stage" "text", "p_status" "text", "p_attempt" integer, "p_duration_ms" integer, "p_error_message" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.pipeline_stage_metrics (
    document_id, stage, status, attempt, duration_ms, error_message
  ) VALUES (
    p_document_id, p_stage, p_status, p_attempt, p_duration_ms, p_error_message
  );
END;
$$;


ALTER FUNCTION "public"."pipeline_record_stage_metric"("p_document_id" "uuid", "p_stage" "text", "p_status" "text", "p_attempt" integer, "p_duration_ms" integer, "p_error_message" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pipeline_stage_is_paused"("p_stage" "text") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pipeline_control
    WHERE stage = p_stage
      AND paused = true
      AND (paused_until IS NULL OR paused_until > now())
  );
$$;


ALTER FUNCTION "public"."pipeline_stage_is_paused"("p_stage" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pipeline_stage_mark_failure"("p_stage" "text", "p_reason" "text", "p_threshold" integer DEFAULT 5, "p_cooldown_minutes" integer DEFAULT 5) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  new_streak integer;
BEGIN
  INSERT INTO public.pipeline_control (stage, paused, paused_until, failure_streak, pause_reason, updated_at)
  VALUES (p_stage, false, NULL, 1, p_reason, now())
  ON CONFLICT (stage)
  DO UPDATE SET
    failure_streak = public.pipeline_control.failure_streak + 1,
    pause_reason = p_reason,
    updated_at = now();

  SELECT failure_streak INTO new_streak
  FROM public.pipeline_control
  WHERE stage = p_stage;

  IF new_streak >= p_threshold THEN
    UPDATE public.pipeline_control
    SET
      paused = true,
      paused_until = now() + make_interval(mins => p_cooldown_minutes),
      updated_at = now()
    WHERE stage = p_stage;
  END IF;
END;
$$;


ALTER FUNCTION "public"."pipeline_stage_mark_failure"("p_stage" "text", "p_reason" "text", "p_threshold" integer, "p_cooldown_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pipeline_stage_mark_success"("p_stage" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.pipeline_control (stage, paused, paused_until, failure_streak, pause_reason, updated_at)
  VALUES (p_stage, false, NULL, 0, NULL, now())
  ON CONFLICT (stage)
  DO UPDATE SET
    paused = false,
    paused_until = NULL,
    failure_streak = 0,
    pause_reason = NULL,
    updated_at = now();
END;
$$;


ALTER FUNCTION "public"."pipeline_stage_mark_success"("p_stage" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pipeline_status_to_stage"("status" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT CASE status
    WHEN 'normalizing' THEN 'NORMALIZE'
    WHEN 'pending'     THEN 'INDEX'
    WHEN 'indexing'    THEN NULL
    WHEN 'classifying' THEN 'CLASSIFY'
    WHEN 'extracting'  THEN 'EXTRACT'
    WHEN 'verifying'   THEN 'EVIDENCE'
    WHEN 'aggregated'  THEN 'AGGREGATE'
    WHEN 'enriching'   THEN 'ENRICH'
    ELSE NULL
  END;
$$;


ALTER FUNCTION "public"."pipeline_status_to_stage"("status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."preview_rescore_batch"("batch_size" integer DEFAULT 100) RETURNS TABLE("id" "uuid", "created_at" timestamp with time zone, "pipeline_status" "text", "has_strip" boolean, "has_scores" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    d.id,
    d.created_at,
    d.pipeline_status,
    (d.strip IS NOT NULL) AS has_strip,
    (d.grounding_score IS NOT NULL OR d.integrity_score IS NOT NULL) AS has_scores
  FROM public.documents d
  WHERE d.strip IS NOT NULL
     OR d.grounding_score IS NOT NULL
     OR d.integrity_score IS NOT NULL
  ORDER BY d.created_at ASC
  LIMIT GREATEST(batch_size, 1);
$$;


ALTER FUNCTION "public"."preview_rescore_batch"("batch_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."calibration_audit" (
    "audit_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scoring_version" integer NOT NULL,
    "calibration_type" "text" NOT NULL,
    "parameters" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "metrics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "approved" boolean DEFAULT false,
    "approved_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text",
    CONSTRAINT "calibration_audit_calibration_type_check" CHECK (("calibration_type" = ANY (ARRAY['anchor'::"text", 'outlet'::"text", 'human'::"text", 'parameter_update'::"text"])))
);


ALTER TABLE "public"."calibration_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "segment_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "claim_text" "text" NOT NULL,
    "sire_scope" "jsonb" DEFAULT '{}'::"jsonb",
    "sire_information" "jsonb" DEFAULT '{}'::"jsonb",
    "sire_retrieval" "jsonb" DEFAULT '{}'::"jsonb",
    "sire_exclusions" "jsonb" DEFAULT '{}'::"jsonb",
    "veracity_label" "text",
    "confidence_score" real,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "risk_level" "text" DEFAULT 'LOW'::"text",
    "gap_reason" "text",
    "conflict_basis" "text",
    CONSTRAINT "claims_veracity_label_check" CHECK (("veracity_label" = ANY (ARRAY['SUPPORTED'::"text", 'CONTRADICTED'::"text", 'MIXED'::"text", 'UNKNOWN'::"text", 'NOT_CHECKABLE'::"text"])))
);


ALTER TABLE "public"."claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "feed_id" "uuid" NOT NULL,
    "url" "text" NOT NULL,
    "title" "text",
    "author" "text",
    "published_at" timestamp with time zone,
    "raw_content" "text",
    "normalized_content" "text",
    "word_count" integer,
    "fetch_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "pipeline_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "strip" "jsonb",
    "grounding_score" real,
    "integrity_score" real,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "corpus_front_matter" "jsonb" DEFAULT '{}'::"jsonb",
    "sentiment_compound" real,
    "sentiment_pos" real,
    "sentiment_neg" real,
    "sentiment_neu" real,
    "synthesis_text" "text",
    "synthesis_sources" "jsonb",
    "sourcing_quality" real,
    "one_sidedness" real,
    "factuality_score" real,
    "ideology_scores" "jsonb",
    "event_id" "uuid",
    "story_id" "uuid",
    "enriched_entities" "text"[] DEFAULT '{}'::"text"[],
    "enriched_geo" "text",
    "enriched_event_type" "text",
    "event_key" "text",
    CONSTRAINT "documents_fetch_status_check" CHECK (("fetch_status" = ANY (ARRAY['pending'::"text", 'fetched'::"text", 'normalized'::"text", 'failed'::"text"]))),
    CONSTRAINT "documents_pipeline_status_check" CHECK (("pipeline_status" = ANY (ARRAY['pending'::"text", 'normalizing'::"text", 'indexing'::"text", 'classifying'::"text", 'extracting'::"text", 'verifying'::"text", 'aggregated'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_story_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "story_id" "uuid" NOT NULL,
    "link_score" real,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."event_story_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_key" "text",
    "event_type" "text" DEFAULT 'unclassified'::"text" NOT NULL,
    "geo_primary" "text",
    "time_bucket" timestamp with time zone,
    "entities" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "topics" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "title" "text",
    "summary" "text",
    "doc_centroid" "extensions"."vector"(1536),
    "claim_centroid" "extensions"."vector"(1536),
    "cluster_entities" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "algo_version" integer DEFAULT 1 NOT NULL,
    "document_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."evidence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "source_segment_id" "uuid",
    "evidence_text" "text" NOT NULL,
    "source_tier" "text" NOT NULL,
    "source_url" "text",
    "source_publisher" "text",
    "similarity_score" real,
    "nli_label" "text",
    "nli_confidence" real,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_independent" boolean DEFAULT true,
    CONSTRAINT "evidence_nli_label_check" CHECK (("nli_label" = ANY (ARRAY['ENTAILMENT'::"text", 'CONTRADICTION'::"text", 'NEUTRAL'::"text"]))),
    CONSTRAINT "evidence_source_tier_check" CHECK (("source_tier" = ANY (ARRAY['T1'::"text", 'T2'::"text", 'T3'::"text", 'T4'::"text", 'T5'::"text"])))
);


ALTER TABLE "public"."evidence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."feeds" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "url" "text" NOT NULL,
    "publisher_name" "text" NOT NULL,
    "source_category" "text" DEFAULT 'mainstream'::"text" NOT NULL,
    "polling_interval_minutes" integer DEFAULT 15 NOT NULL,
    "last_polled_at" timestamp with time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "description" "text",
    CONSTRAINT "feeds_source_category_check" CHECK (("source_category" = ANY (ARRAY['mainstream'::"text", 'partisan'::"text", 'fringe'::"text", 'reference'::"text"])))
);


ALTER TABLE "public"."feeds" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ideology_scores" (
    "score_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "theta_raw" double precision,
    "theta_normalized" double precision,
    "se" double precision,
    "theta_economic" double precision,
    "theta_social" double precision,
    "n_stances" integer DEFAULT 0 NOT NULL,
    "n_propositions" integer DEFAULT 0 NOT NULL,
    "mean_confidence" double precision DEFAULT 0 NOT NULL,
    "method" "text" NOT NULL,
    "scoring_version" integer DEFAULT 1 NOT NULL,
    "model_id" "text" DEFAULT 'system'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    CONSTRAINT "ideology_scores_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['segment'::"text", 'document'::"text", 'publisher'::"text"]))),
    CONSTRAINT "ideology_scores_method_check" CHECK (("method" = ANY (ARRAY['map_irt'::"text", 'stance_average_proxy'::"text", 'svd_batch'::"text"])))
);


ALTER TABLE "public"."ideology_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inoreader_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."inoreader_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_control" (
    "stage" "text" NOT NULL,
    "paused" boolean DEFAULT false NOT NULL,
    "paused_until" timestamp with time zone,
    "failure_streak" integer DEFAULT 0 NOT NULL,
    "pause_reason" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pipeline_control" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_dlq" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "doc_id" "uuid" NOT NULL,
    "stage" "text" NOT NULL,
    "attempt" integer DEFAULT 1 NOT NULL,
    "error_message" "text",
    "payload" "jsonb",
    "failed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pipeline_dlq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_enqueue_guard" (
    "doc_id" "uuid" NOT NULL,
    "stage" "text" NOT NULL,
    "status_token" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pipeline_enqueue_guard" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_stage_metrics" (
    "id" bigint NOT NULL,
    "document_id" "uuid",
    "stage" "text" NOT NULL,
    "status" "text" NOT NULL,
    "attempt" integer NOT NULL,
    "duration_ms" integer NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pipeline_stage_metrics" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."pipeline_stage_metrics_hourly" AS
 SELECT "date_trunc"('hour'::"text", "created_at") AS "hour_bucket",
    "stage",
    "count"(*) AS "total",
    "count"(*) FILTER (WHERE ("status" = 'ok'::"text")) AS "ok_count",
    "count"(*) FILTER (WHERE ("status" = 'failed'::"text")) AS "failed_count",
    "round"((("count"(*) FILTER (WHERE ("status" = 'failed'::"text")))::numeric / (NULLIF("count"(*), 0))::numeric), 4) AS "fail_rate",
    "percentile_disc"((0.5)::double precision) WITHIN GROUP (ORDER BY "duration_ms") AS "p50_ms",
    "percentile_disc"((0.95)::double precision) WITHIN GROUP (ORDER BY "duration_ms") AS "p95_ms"
   FROM "public"."pipeline_stage_metrics"
  GROUP BY ("date_trunc"('hour'::"text", "created_at")), "stage";


ALTER VIEW "public"."pipeline_stage_metrics_hourly" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."pipeline_stage_metrics_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."pipeline_stage_metrics_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."pipeline_stage_metrics_id_seq" OWNED BY "public"."pipeline_stage_metrics"."id";



CREATE TABLE IF NOT EXISTS "public"."proposition_bank" (
    "proposition_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "axis" "text" NOT NULL,
    "dimension" "text",
    "domain" "text" NOT NULL,
    "text" "text" NOT NULL,
    "keywords" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "embedding" "extensions"."vector"(1536),
    "liberal_is_pro" boolean NOT NULL,
    "discrimination_a" double precision DEFAULT 1.0 NOT NULL,
    "difficulty_b" double precision DEFAULT 0.0 NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deprecated_at" timestamp with time zone,
    "notes" "text",
    CONSTRAINT "proposition_bank_axis_check" CHECK (("axis" = ANY (ARRAY['US_1D'::"text", 'US_2D'::"text"]))),
    CONSTRAINT "proposition_bank_dimension_check" CHECK (("dimension" = ANY (ARRAY['economic'::"text", 'social'::"text", 'foreign'::"text", 'executive'::"text", 'general'::"text"]))),
    CONSTRAINT "proposition_bank_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'deprecated'::"text", 'testing'::"text"])))
);


ALTER TABLE "public"."proposition_bank" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."publisher_baselines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "publisher_name" "text" NOT NULL,
    "period" "text" NOT NULL,
    "avg_grounding_score" real,
    "avg_integrity_score" real,
    "avg_contradiction_rate" real,
    "segment_label_distribution" "jsonb" DEFAULT '{}'::"jsonb",
    "document_count" integer DEFAULT 0,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "avg_sourcing_quality" real,
    "avg_one_sidedness" real,
    "avg_factuality_score" real,
    "avg_ideology_economic" real,
    "avg_ideology_social" real,
    CONSTRAINT "publisher_baselines_period_check" CHECK (("period" = ANY (ARRAY['7d'::"text", '30d'::"text"])))
);


ALTER TABLE "public"."publisher_baselines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."segments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "position_index" integer NOT NULL,
    "text_content" "text" NOT NULL,
    "token_count" integer,
    "embedding" "extensions"."vector"(1536),
    "classification" "text",
    "rhetorical_flags" "jsonb" DEFAULT '[]'::"jsonb",
    "label" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sentiment_compound" real,
    "sentiment_pos" real,
    "sentiment_neg" real,
    "sentiment_neu" real,
    CONSTRAINT "segments_classification_check" CHECK (("classification" = ANY (ARRAY['FACTUAL_CLAIM'::"text", 'OPINION_ANALYSIS'::"text", 'PROCEDURAL'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "segments_label_check" CHECK (("label" = ANY (ARRAY['SUPPORTED'::"text", 'CONTRADICTED'::"text", 'MIXED'::"text", 'UNKNOWN'::"text", 'NOT_CHECKABLE'::"text", 'OPINION'::"text", 'NEUTRAL'::"text", 'OTHER'::"text"])))
);


ALTER TABLE "public"."segments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stance_extractions" (
    "extraction_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "segment_id" "uuid" NOT NULL,
    "proposition_id" "uuid" NOT NULL,
    "stance" "text" NOT NULL,
    "confidence" double precision NOT NULL,
    "quoted_span_start" integer,
    "quoted_span_end" integer,
    "quoted_text" "text",
    "model_id" "text" NOT NULL,
    "model_version" "text" DEFAULT '1'::"text" NOT NULL,
    "scoring_version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "stance_extractions_confidence_check" CHECK ((("confidence" >= (0.0)::double precision) AND ("confidence" <= (1.0)::double precision))),
    CONSTRAINT "stance_extractions_stance_check" CHECK (("stance" = ANY (ARRAY['PRO'::"text", 'ANTI'::"text", 'NEUTRAL'::"text", 'UNCLEAR'::"text"])))
);


ALTER TABLE "public"."stance_extractions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text",
    "summary" "text",
    "claim_centroid" "extensions"."vector"(1536),
    "entities" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "topics" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "algo_version" integer DEFAULT 1 NOT NULL,
    "event_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."stories" OWNER TO "postgres";


ALTER TABLE ONLY "public"."pipeline_stage_metrics" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."pipeline_stage_metrics_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."calibration_audit"
    ADD CONSTRAINT "calibration_audit_pkey" PRIMARY KEY ("audit_id");



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_url_key" UNIQUE ("url");



ALTER TABLE ONLY "public"."event_story_links"
    ADD CONSTRAINT "event_story_links_event_id_story_id_key" UNIQUE ("event_id", "story_id");



ALTER TABLE ONLY "public"."event_story_links"
    ADD CONSTRAINT "event_story_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_event_key_key" UNIQUE ("event_key");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."evidence"
    ADD CONSTRAINT "evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."feeds"
    ADD CONSTRAINT "feeds_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."feeds"
    ADD CONSTRAINT "feeds_url_key" UNIQUE ("url");



ALTER TABLE ONLY "public"."ideology_scores"
    ADD CONSTRAINT "ideology_scores_pkey" PRIMARY KEY ("score_id");



ALTER TABLE ONLY "public"."inoreader_tokens"
    ADD CONSTRAINT "inoreader_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_control"
    ADD CONSTRAINT "pipeline_control_pkey" PRIMARY KEY ("stage");



ALTER TABLE ONLY "public"."pipeline_dlq"
    ADD CONSTRAINT "pipeline_dlq_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_enqueue_guard"
    ADD CONSTRAINT "pipeline_enqueue_guard_pkey" PRIMARY KEY ("doc_id", "stage", "status_token");



ALTER TABLE ONLY "public"."pipeline_stage_metrics"
    ADD CONSTRAINT "pipeline_stage_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."proposition_bank"
    ADD CONSTRAINT "proposition_bank_pkey" PRIMARY KEY ("proposition_id");



ALTER TABLE ONLY "public"."publisher_baselines"
    ADD CONSTRAINT "publisher_baselines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."publisher_baselines"
    ADD CONSTRAINT "publisher_baselines_publisher_name_period_key" UNIQUE ("publisher_name", "period");



ALTER TABLE ONLY "public"."segments"
    ADD CONSTRAINT "segments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stance_extractions"
    ADD CONSTRAINT "stance_extractions_pkey" PRIMARY KEY ("extraction_id");



ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_claims_document_id" ON "public"."claims" USING "btree" ("document_id");



CREATE INDEX "idx_claims_segment_id" ON "public"."claims" USING "btree" ("segment_id");



CREATE INDEX "idx_claims_veracity" ON "public"."claims" USING "btree" ("veracity_label");



CREATE INDEX "idx_documents_event_id" ON "public"."documents" USING "btree" ("event_id");



CREATE INDEX "idx_documents_event_key" ON "public"."documents" USING "btree" ("event_key");



CREATE INDEX "idx_documents_feed_id" ON "public"."documents" USING "btree" ("feed_id");



CREATE INDEX "idx_documents_pipeline_status" ON "public"."documents" USING "btree" ("pipeline_status");



CREATE INDEX "idx_documents_published_at" ON "public"."documents" USING "btree" ("published_at" DESC);



CREATE INDEX "idx_documents_story_id" ON "public"."documents" USING "btree" ("story_id");



CREATE INDEX "idx_event_story_links_event" ON "public"."event_story_links" USING "btree" ("event_id");



CREATE INDEX "idx_event_story_links_story" ON "public"."event_story_links" USING "btree" ("story_id");



CREATE INDEX "idx_events_event_key" ON "public"."events" USING "btree" ("event_key");



CREATE INDEX "idx_events_time_bucket" ON "public"."events" USING "btree" ("time_bucket");



CREATE INDEX "idx_evidence_claim_id" ON "public"."evidence" USING "btree" ("claim_id");



CREATE UNIQUE INDEX "idx_ideology_scores_entity_unique" ON "public"."ideology_scores" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "idx_pipeline_enqueue_guard_created_at" ON "public"."pipeline_enqueue_guard" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_pipeline_stage_metrics_created_at" ON "public"."pipeline_stage_metrics" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_pipeline_stage_metrics_stage_created_at" ON "public"."pipeline_stage_metrics" USING "btree" ("stage", "created_at" DESC);



CREATE INDEX "idx_prop_domain" ON "public"."proposition_bank" USING "btree" ("domain");



CREATE INDEX "idx_prop_status" ON "public"."proposition_bank" USING "btree" ("status") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_scores_entity" ON "public"."ideology_scores" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "idx_scores_version" ON "public"."ideology_scores" USING "btree" ("scoring_version");



CREATE INDEX "idx_segments_classification" ON "public"."segments" USING "btree" ("classification");



CREATE INDEX "idx_segments_document_id" ON "public"."segments" USING "btree" ("document_id");



CREATE INDEX "idx_stance_proposition" ON "public"."stance_extractions" USING "btree" ("proposition_id");



CREATE INDEX "idx_stance_segment" ON "public"."stance_extractions" USING "btree" ("segment_id");



CREATE UNIQUE INDEX "idx_stance_unique" ON "public"."stance_extractions" USING "btree" ("segment_id", "proposition_id", "scoring_version");



CREATE OR REPLACE TRIGGER "trg_pipeline_enqueue" AFTER UPDATE OF "pipeline_status" ON "public"."documents" FOR EACH ROW EXECUTE FUNCTION "public"."enqueue_pipeline_stage"();



CREATE OR REPLACE TRIGGER "update_documents_updated_at" BEFORE UPDATE ON "public"."documents" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_events_updated_at" BEFORE UPDATE ON "public"."events" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_feeds_updated_at" BEFORE UPDATE ON "public"."feeds" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_inoreader_tokens_updated_at" BEFORE UPDATE ON "public"."inoreader_tokens" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_stories_updated_at" BEFORE UPDATE ON "public"."stories" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_feed_id_fkey" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id");



ALTER TABLE ONLY "public"."event_story_links"
    ADD CONSTRAINT "event_story_links_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_story_links"
    ADD CONSTRAINT "event_story_links_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."evidence"
    ADD CONSTRAINT "evidence_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."evidence"
    ADD CONSTRAINT "evidence_source_segment_id_fkey" FOREIGN KEY ("source_segment_id") REFERENCES "public"."segments"("id");



ALTER TABLE ONLY "public"."segments"
    ADD CONSTRAINT "segments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stance_extractions"
    ADD CONSTRAINT "stance_extractions_proposition_id_fkey" FOREIGN KEY ("proposition_id") REFERENCES "public"."proposition_bank"("proposition_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stance_extractions"
    ADD CONSTRAINT "stance_extractions_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE CASCADE;



CREATE POLICY "Baselines are publicly readable" ON "public"."publisher_baselines" FOR SELECT USING (true);



CREATE POLICY "Baselines are updatable by service role" ON "public"."publisher_baselines" FOR UPDATE USING (false);



CREATE POLICY "Baselines are writable by service role" ON "public"."publisher_baselines" FOR INSERT WITH CHECK (false);



CREATE POLICY "Calibration audits are publicly readable" ON "public"."calibration_audit" FOR SELECT USING (true);



CREATE POLICY "Calibration audits are writable by service role" ON "public"."calibration_audit" FOR INSERT WITH CHECK (false);



CREATE POLICY "Claims are deletable by service role" ON "public"."claims" FOR DELETE USING (false);



CREATE POLICY "Claims are publicly readable" ON "public"."claims" FOR SELECT USING (true);



CREATE POLICY "Claims are updatable by service role" ON "public"."claims" FOR UPDATE USING (false);



CREATE POLICY "Claims are writable by service role" ON "public"."claims" FOR INSERT WITH CHECK (false);



CREATE POLICY "DLQ denied for client roles" ON "public"."pipeline_dlq" USING (false) WITH CHECK (false);



CREATE POLICY "DLQ is deletable by service role" ON "public"."pipeline_dlq" FOR DELETE USING (false);



CREATE POLICY "DLQ is writable by service role" ON "public"."pipeline_dlq" FOR INSERT WITH CHECK (false);



CREATE POLICY "Documents are deletable by service role" ON "public"."documents" FOR DELETE USING (false);



CREATE POLICY "Documents are publicly readable" ON "public"."documents" FOR SELECT USING (true);



CREATE POLICY "Documents are updatable by service role" ON "public"."documents" FOR UPDATE USING (false);



CREATE POLICY "Documents are writable by service role" ON "public"."documents" FOR INSERT WITH CHECK (false);



CREATE POLICY "Event story links are deletable by service role" ON "public"."event_story_links" FOR DELETE USING (false);



CREATE POLICY "Event story links are publicly readable" ON "public"."event_story_links" FOR SELECT USING (true);



CREATE POLICY "Event story links are writable by service role" ON "public"."event_story_links" FOR INSERT WITH CHECK (false);



CREATE POLICY "Events are deletable by service role" ON "public"."events" FOR DELETE USING (false);



CREATE POLICY "Events are publicly readable" ON "public"."events" FOR SELECT USING (true);



CREATE POLICY "Events are updatable by service role" ON "public"."events" FOR UPDATE USING (false);



CREATE POLICY "Events are writable by service role" ON "public"."events" FOR INSERT WITH CHECK (false);



CREATE POLICY "Evidence is deletable by service role" ON "public"."evidence" FOR DELETE USING (false);



CREATE POLICY "Evidence is publicly readable" ON "public"."evidence" FOR SELECT USING (true);



CREATE POLICY "Evidence is updatable by service role" ON "public"."evidence" FOR UPDATE USING (false);



CREATE POLICY "Evidence is writable by service role" ON "public"."evidence" FOR INSERT WITH CHECK (false);



CREATE POLICY "Feeds are deletable by service role" ON "public"."feeds" FOR DELETE USING (false);



CREATE POLICY "Feeds are publicly readable" ON "public"."feeds" FOR SELECT USING (true);



CREATE POLICY "Feeds are updatable by service role" ON "public"."feeds" FOR UPDATE USING (false);



CREATE POLICY "Feeds are writable by service role" ON "public"."feeds" FOR INSERT WITH CHECK (false);



CREATE POLICY "Ideology scores are deletable by service role" ON "public"."ideology_scores" FOR DELETE USING (false);



CREATE POLICY "Ideology scores are publicly readable" ON "public"."ideology_scores" FOR SELECT USING (true);



CREATE POLICY "Ideology scores are updatable by service role" ON "public"."ideology_scores" FOR UPDATE USING (false);



CREATE POLICY "Ideology scores are writable by service role" ON "public"."ideology_scores" FOR INSERT WITH CHECK (false);



CREATE POLICY "Inoreader tokens are readable by service role only" ON "public"."inoreader_tokens" FOR SELECT USING (false);



CREATE POLICY "Inoreader tokens are updatable by service role only" ON "public"."inoreader_tokens" FOR UPDATE USING (false);



CREATE POLICY "Inoreader tokens are writable by service role only" ON "public"."inoreader_tokens" FOR INSERT WITH CHECK (false);



CREATE POLICY "Propositions are deletable by service role" ON "public"."proposition_bank" FOR DELETE USING (false);



CREATE POLICY "Propositions are publicly readable" ON "public"."proposition_bank" FOR SELECT USING (true);



CREATE POLICY "Propositions are updatable by service role" ON "public"."proposition_bank" FOR UPDATE USING (false);



CREATE POLICY "Propositions are writable by service role" ON "public"."proposition_bank" FOR INSERT WITH CHECK (false);



CREATE POLICY "Segments are deletable by service role" ON "public"."segments" FOR DELETE USING (false);



CREATE POLICY "Segments are publicly readable" ON "public"."segments" FOR SELECT USING (true);



CREATE POLICY "Segments are updatable by service role" ON "public"."segments" FOR UPDATE USING (false);



CREATE POLICY "Segments are writable by service role" ON "public"."segments" FOR INSERT WITH CHECK (false);



CREATE POLICY "Stances are deletable by service role" ON "public"."stance_extractions" FOR DELETE USING (false);



CREATE POLICY "Stances are publicly readable" ON "public"."stance_extractions" FOR SELECT USING (true);



CREATE POLICY "Stances are updatable by service role" ON "public"."stance_extractions" FOR UPDATE USING (false);



CREATE POLICY "Stances are writable by service role" ON "public"."stance_extractions" FOR INSERT WITH CHECK (false);



CREATE POLICY "Stories are deletable by service role" ON "public"."stories" FOR DELETE USING (false);



CREATE POLICY "Stories are publicly readable" ON "public"."stories" FOR SELECT USING (true);



CREATE POLICY "Stories are updatable by service role" ON "public"."stories" FOR UPDATE USING (false);



CREATE POLICY "Stories are writable by service role" ON "public"."stories" FOR INSERT WITH CHECK (false);



ALTER TABLE "public"."calibration_audit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claims" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_story_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."evidence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."feeds" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ideology_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inoreader_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_dlq" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."proposition_bank" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."publisher_baselines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."segments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stance_extractions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stories" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."documents";









GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";










































































































































































































































































































































































































































































































































GRANT ALL ON FUNCTION "public"."backfill_rescore_batch"("batch_size" integer, "reset_synthesis" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."backfill_rescore_batch"("batch_size" integer, "reset_synthesis" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."backfill_rescore_batch"("batch_size" integer, "reset_synthesis" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."enqueue_pipeline_stage"() TO "anon";
GRANT ALL ON FUNCTION "public"."enqueue_pipeline_stage"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enqueue_pipeline_stage"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enqueue_stage_if_new"("p_doc_id" "uuid", "p_stage" "text", "p_status_token" "text", "p_attempt" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."enqueue_stage_if_new"("p_doc_id" "uuid", "p_stage" "text", "p_status_token" "text", "p_attempt" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."enqueue_stage_if_new"("p_doc_id" "uuid", "p_stage" "text", "p_status_token" "text", "p_attempt" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."enqueue_stuck_docs"("target_status" "text", "target_stage" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."enqueue_stuck_docs"("target_status" "text", "target_stage" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."enqueue_stuck_docs"("target_status" "text", "target_stage" "text") TO "service_role";









GRANT ALL ON FUNCTION "public"."pgmq_archive"("queue_name" "text", "msg_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."pgmq_archive"("queue_name" "text", "msg_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."pgmq_archive"("queue_name" "text", "msg_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."pgmq_read"("queue_name" "text", "vt" integer, "qty" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."pgmq_read"("queue_name" "text", "vt" integer, "qty" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."pgmq_read"("queue_name" "text", "vt" integer, "qty" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."pgmq_send"("queue_name" "text", "msg" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."pgmq_send"("queue_name" "text", "msg" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pgmq_send"("queue_name" "text", "msg" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."pipeline_ops_summary"() TO "anon";
GRANT ALL ON FUNCTION "public"."pipeline_ops_summary"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."pipeline_ops_summary"() TO "service_role";



GRANT ALL ON FUNCTION "public"."pipeline_reap_poisoned"("p_max_read_ct" integer, "p_batch_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."pipeline_reap_poisoned"("p_max_read_ct" integer, "p_batch_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."pipeline_reap_poisoned"("p_max_read_ct" integer, "p_batch_size" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."pipeline_record_stage_metric"("p_document_id" "uuid", "p_stage" "text", "p_status" "text", "p_attempt" integer, "p_duration_ms" integer, "p_error_message" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pipeline_record_stage_metric"("p_document_id" "uuid", "p_stage" "text", "p_status" "text", "p_attempt" integer, "p_duration_ms" integer, "p_error_message" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pipeline_record_stage_metric"("p_document_id" "uuid", "p_stage" "text", "p_status" "text", "p_attempt" integer, "p_duration_ms" integer, "p_error_message" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."pipeline_stage_is_paused"("p_stage" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pipeline_stage_is_paused"("p_stage" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pipeline_stage_is_paused"("p_stage" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."pipeline_stage_mark_failure"("p_stage" "text", "p_reason" "text", "p_threshold" integer, "p_cooldown_minutes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."pipeline_stage_mark_failure"("p_stage" "text", "p_reason" "text", "p_threshold" integer, "p_cooldown_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."pipeline_stage_mark_failure"("p_stage" "text", "p_reason" "text", "p_threshold" integer, "p_cooldown_minutes" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."pipeline_stage_mark_success"("p_stage" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pipeline_stage_mark_success"("p_stage" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pipeline_stage_mark_success"("p_stage" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."pipeline_status_to_stage"("status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pipeline_status_to_stage"("status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pipeline_status_to_stage"("status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."preview_rescore_batch"("batch_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."preview_rescore_batch"("batch_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."preview_rescore_batch"("batch_size" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";




































GRANT ALL ON TABLE "public"."calibration_audit" TO "anon";
GRANT ALL ON TABLE "public"."calibration_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."calibration_audit" TO "service_role";



GRANT ALL ON TABLE "public"."claims" TO "anon";
GRANT ALL ON TABLE "public"."claims" TO "authenticated";
GRANT ALL ON TABLE "public"."claims" TO "service_role";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";



GRANT ALL ON TABLE "public"."event_story_links" TO "anon";
GRANT ALL ON TABLE "public"."event_story_links" TO "authenticated";
GRANT ALL ON TABLE "public"."event_story_links" TO "service_role";



GRANT ALL ON TABLE "public"."events" TO "anon";
GRANT ALL ON TABLE "public"."events" TO "authenticated";
GRANT ALL ON TABLE "public"."events" TO "service_role";



GRANT ALL ON TABLE "public"."evidence" TO "anon";
GRANT ALL ON TABLE "public"."evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."evidence" TO "service_role";



GRANT ALL ON TABLE "public"."feeds" TO "anon";
GRANT ALL ON TABLE "public"."feeds" TO "authenticated";
GRANT ALL ON TABLE "public"."feeds" TO "service_role";



GRANT ALL ON TABLE "public"."ideology_scores" TO "anon";
GRANT ALL ON TABLE "public"."ideology_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."ideology_scores" TO "service_role";



GRANT ALL ON TABLE "public"."inoreader_tokens" TO "anon";
GRANT ALL ON TABLE "public"."inoreader_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."inoreader_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_control" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_control" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_control" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_dlq" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_dlq" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_dlq" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_enqueue_guard" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_enqueue_guard" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_enqueue_guard" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_stage_metrics" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_stage_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_stage_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_stage_metrics_hourly" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_stage_metrics_hourly" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_stage_metrics_hourly" TO "service_role";



GRANT ALL ON SEQUENCE "public"."pipeline_stage_metrics_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."pipeline_stage_metrics_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."pipeline_stage_metrics_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."proposition_bank" TO "anon";
GRANT ALL ON TABLE "public"."proposition_bank" TO "authenticated";
GRANT ALL ON TABLE "public"."proposition_bank" TO "service_role";



GRANT ALL ON TABLE "public"."publisher_baselines" TO "anon";
GRANT ALL ON TABLE "public"."publisher_baselines" TO "authenticated";
GRANT ALL ON TABLE "public"."publisher_baselines" TO "service_role";



GRANT ALL ON TABLE "public"."segments" TO "anon";
GRANT ALL ON TABLE "public"."segments" TO "authenticated";
GRANT ALL ON TABLE "public"."segments" TO "service_role";



GRANT ALL ON TABLE "public"."stance_extractions" TO "anon";
GRANT ALL ON TABLE "public"."stance_extractions" TO "authenticated";
GRANT ALL ON TABLE "public"."stance_extractions" TO "service_role";



GRANT ALL ON TABLE "public"."stories" TO "anon";
GRANT ALL ON TABLE "public"."stories" TO "authenticated";
GRANT ALL ON TABLE "public"."stories" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
































--
-- Dumped schema changes for auth and storage
--

