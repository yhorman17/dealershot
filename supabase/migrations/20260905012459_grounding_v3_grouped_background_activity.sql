-- Grounding V3 keeps one backdrop-aware floor model in the browser and worker.
-- The processing activity projection groups authoritative durable jobs by vehicle.

ALTER TABLE public.backdrops
  ADD COLUMN IF NOT EXISTS floor_finish text NOT NULL DEFAULT 'semi_gloss';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'backdrops_floor_finish_check'
      AND conrelid = 'public.backdrops'::regclass
  ) THEN
    ALTER TABLE public.backdrops
      ADD CONSTRAINT backdrops_floor_finish_check
      CHECK (floor_finish IN ('matte', 'semi_gloss', 'glossy'));
  END IF;
END;
$$;

-- Rick Case Volkswagen's existing Show room 2 resource is a bright reflective
-- floor. The stable resource identity is intentional; display names may change.
UPDATE public.backdrops
SET floor_finish = 'glossy'
WHERE id = '51881c70-0dcb-4e05-8cd3-975d4ce935b1'::uuid;

CREATE OR REPLACE FUNCTION public.worker_get_background_removal_source(_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'job_id', job.id,
    'actor_id', job.created_by,
    'media_asset_id', asset.id,
    'dealership_id', asset.dealership_id,
    'vehicle_id', asset.vehicle_id,
    'photo_id', photo.id,
    'shot_type', photo.shot_type,
    'source_variant_id', variant.id,
    'bucket', variant.storage_bucket,
    'path', variant.storage_path,
    'content_type', variant.content_type,
    'default_backdrop_id', backdrop.id,
    'default_backdrop_bucket', backdrop.storage_bucket,
    'default_backdrop_path', backdrop.storage_path,
    'default_backdrop_floor_finish', backdrop.floor_finish
  )
  FROM private.background_jobs AS job
  JOIN public.media_assets AS asset ON asset.id = job.resource_id
  JOIN public.photos AS photo ON photo.media_asset_id = asset.id
  JOIN public.media_variants AS variant ON variant.media_asset_id = asset.id
    AND variant.variant_type = 'original' AND variant.archived_at IS NULL
  LEFT JOIN public.photography_settings AS settings
    ON settings.dealership_id = asset.dealership_id
  LEFT JOIN public.backdrops AS backdrop
    ON backdrop.id = settings.default_backdrop_id
    AND backdrop.dealership_id = asset.dealership_id
    AND backdrop.storage_bucket = 'backdrops'
    AND backdrop.storage_path LIKE asset.dealership_id::text || '/%'
  WHERE job.id = _job_id
    AND job.job_type = 'media.background.remove'
    AND job.status = 'running'
    AND job.cancel_requested_at IS NULL
    AND asset.lifecycle_state = 'active'
    AND asset.vehicle_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.get_background_removal_activity_grouped(
  _dealership_id uuid,
  _vehicle_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'media') THEN
    RAISE EXCEPTION 'Background processing activity is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF _vehicle_limit NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'Invalid vehicle activity limit.' USING ERRCODE = '22023';
  END IF;

  WITH activity AS MATERIALIZED (
    SELECT
      job.id AS job_id,
      job.resource_id AS media_asset_id,
      NULLIF(job.payload ->> 'photo_id', '')::uuid AS photo_id,
      asset.vehicle_id,
      vehicle.stock_number,
      concat_ws(' ', vehicle.year::text, NULLIF(vehicle.make, ''), NULLIF(vehicle.model, ''))
        AS vehicle_label,
      photo.shot_type,
      photo.sort_order AS photo_sort_order,
      CASE
        WHEN job.status = 'cancelled' OR job.cancel_requested_at IS NOT NULL THEN 'canceled'
        WHEN job.status IN ('queued', 'retry_scheduled') THEN 'queued'
        WHEN job.status = 'running' THEN 'processing'
        WHEN job.status = 'succeeded' AND job.draft_variant_id IS NOT NULL THEN 'needs_review'
        WHEN job.status = 'succeeded' THEN 'completed'
        WHEN job.status = 'dead_letter' AND job.draft_variant_id IS NOT NULL THEN 'needs_review'
        WHEN job.status = 'dead_letter' THEN 'failed'
        ELSE job.status
      END AS status,
      CASE
        WHEN job.status NOT IN ('dead_letter', 'succeeded') THEN false
        WHEN job.failure_category = 'source_invalid' THEN false
        WHEN job.failure_category IN ('model_rejection', 'resource_failure')
          THEN job.deterministic_failure_count < 2
        WHEN job.failure_category IN ('transient', 'finalization_failure')
          THEN job.attempt_count < 25
        WHEN job.failure_category IS NULL THEN job.attempt_count < 2
        ELSE false
      END AS retryable,
      job.status IN ('queued', 'retry_scheduled', 'running', 'dead_letter')
        AND job.cancel_requested_at IS NULL AS cancelable,
      job.cancel_requested_at IS NOT NULL AS cancel_requested,
      job.failure_category,
      job.deterministic_failure_count,
      job.draft_variant_id IS NOT NULL AS has_draft,
      job.draft_variant_id IS NOT NULL AS fix_cutout_available,
      CASE
        WHEN job.draft_variant_id IS NOT NULL THEN
          'Automatic background removal could not isolate this vehicle cleanly. Fix the cutout manually or keep the original.'
        WHEN job.failure_category = 'source_invalid' THEN
          'DealerShot could not read this photo. The original remains unchanged.'
        WHEN job.status = 'dead_letter' THEN
          'Automatic background removal could not process this photo. The original remains unchanged.'
        ELSE NULL
      END AS safe_failure_label,
      job.attempt_count,
      job.max_attempts,
      job.created_at,
      job.started_at,
      job.completed_at,
      job.updated_at,
      COALESCE(asset.vehicle_id::text, 'job:' || job.id::text) AS vehicle_group_key
    FROM private.background_jobs AS job
    LEFT JOIN public.media_assets AS asset
      ON asset.id = job.resource_id AND job.resource_type = 'media_asset'
    LEFT JOIN public.vehicles AS vehicle
      ON vehicle.id = asset.vehicle_id AND vehicle.dealership_id = _dealership_id
    LEFT JOIN public.photos AS photo
      ON photo.id = NULLIF(job.payload ->> 'photo_id', '')::uuid
    WHERE job.dealership_id = _dealership_id
      AND job.job_type = 'media.background.remove'
      AND (
        job.status IN ('queued', 'running', 'retry_scheduled')
        OR (job.status = 'succeeded' AND job.completed_at >= now() - interval '1 hour')
        OR (job.status = 'succeeded' AND job.draft_variant_id IS NOT NULL)
        OR (job.status = 'dead_letter' AND job.completed_at >= now() - interval '7 days')
        OR (job.status = 'cancelled' AND job.completed_at >= now() - interval '1 hour')
      )
  ), vehicle_keys AS (
    SELECT vehicle_group_key, max(updated_at) AS latest_updated_at
    FROM activity
    GROUP BY vehicle_group_key
    ORDER BY latest_updated_at DESC
    LIMIT _vehicle_limit
  ), selected AS MATERIALIZED (
    SELECT activity.*
    FROM activity
    JOIN vehicle_keys USING (vehicle_group_key)
  ), grouped AS (
    SELECT
      vehicle_group_key,
      max(vehicle_id::text)::uuid AS vehicle_id,
      max(stock_number) AS stock_number,
      max(vehicle_label) AS vehicle_label,
      max(updated_at) AS updated_at,
      count(*)::integer AS total_count,
      count(*) FILTER (WHERE status = 'queued')::integer AS queued_count,
      count(*) FILTER (WHERE status = 'processing')::integer AS processing_count,
      count(*) FILTER (WHERE status = 'completed')::integer AS completed_count,
      count(*) FILTER (WHERE status = 'needs_review')::integer AS needs_review_count,
      count(*) FILTER (WHERE status = 'failed')::integer AS failed_count,
      count(*) FILTER (WHERE status = 'canceled')::integer AS canceled_count,
      count(*) FILTER (WHERE status = 'failed' AND retryable)::integer AS retryable_failed_count,
      count(*) FILTER (WHERE cancelable)::integer AS cancelable_count,
      jsonb_agg(to_jsonb(selected) - 'vehicle_group_key'
        ORDER BY photo_sort_order NULLS LAST, created_at, job_id) AS items
    FROM selected
    GROUP BY vehicle_group_key
  )
  SELECT jsonb_build_object(
    'vehicles', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'group_key', vehicle_group_key,
          'vehicle_id', vehicle_id,
          'stock_number', stock_number,
          'vehicle_label', vehicle_label,
          'counts', jsonb_build_object(
            'queued', queued_count,
            'processing', processing_count,
            'completed', completed_count,
            'needs_review', needs_review_count,
            'failed', failed_count,
            'canceled', canceled_count,
            'total', total_count,
            'terminal', completed_count + needs_review_count + failed_count + canceled_count
          ),
          'progress_percent', CASE
            WHEN total_count = 0 THEN 0
            ELSE round(100.0 *
              (completed_count + needs_review_count + failed_count + canceled_count) /
              total_count)::integer
          END,
          'retryable_failed_count', retryable_failed_count,
          'cancelable_count', cancelable_count,
          'updated_at', updated_at,
          'items', items
        ) ORDER BY updated_at DESC
      )
      FROM grouped
    ), '[]'::jsonb),
    'totals', COALESCE((
      SELECT jsonb_build_object(
        'queued', count(*) FILTER (WHERE status = 'queued'),
        'processing', count(*) FILTER (WHERE status = 'processing'),
        'completed', count(*) FILTER (WHERE status = 'completed'),
        'needs_review', count(*) FILTER (WHERE status = 'needs_review'),
        'failed', count(*) FILTER (WHERE status = 'failed'),
        'canceled', count(*) FILTER (WHERE status = 'canceled'),
        'total', count(*)
      )
      FROM selected
    ), jsonb_build_object(
      'queued', 0, 'processing', 0, 'completed', 0,
      'needs_review', 0, 'failed', 0, 'canceled', 0, 'total', 0
    ))
  ) INTO result;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.retry_failed_background_removals_for_vehicle(
  _dealership_id uuid,
  _vehicle_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target private.background_jobs%ROWTYPE;
  item_result jsonb;
  failed_count integer := 0;
  retried_count integer := 0;
  not_retryable_count integer := 0;
  already_active_count integer := 0;
  already_completed_count integer := 0;
  retry_allowed boolean;
BEGIN
  IF actor_id IS NULL
     OR NOT private.current_user_has_store_capability(_dealership_id, 'media') THEN
    RAISE EXCEPTION 'Vehicle background-removal retry is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.vehicles
    WHERE id = _vehicle_id AND dealership_id = _dealership_id
  ) THEN
    RAISE EXCEPTION 'Vehicle background-removal retry is unavailable.' USING ERRCODE = '22023';
  END IF;

  FOR target IN
    SELECT job.*
    FROM private.background_jobs AS job
    JOIN public.media_assets AS asset
      ON asset.id = job.resource_id
     AND job.resource_type = 'media_asset'
     AND asset.dealership_id = _dealership_id
     AND asset.vehicle_id = _vehicle_id
     AND asset.lifecycle_state = 'active'
    WHERE job.dealership_id = _dealership_id
      AND job.job_type = 'media.background.remove'
      AND job.status = 'dead_letter'
    ORDER BY job.created_at, job.id
    FOR UPDATE OF job
  LOOP
    failed_count := failed_count + 1;
    IF EXISTS (
      SELECT 1 FROM private.background_jobs AS active_job
      WHERE active_job.id <> target.id
        AND active_job.job_type = 'media.background.remove'
        AND active_job.resource_type = 'media_asset'
        AND active_job.resource_id = target.resource_id
        AND active_job.status IN ('queued', 'retry_scheduled', 'running')
        AND active_job.cancel_requested_at IS NULL
    ) THEN
      already_active_count := already_active_count + 1;
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.media_variants AS variant
      WHERE variant.media_asset_id = target.resource_id
        AND variant.variant_type IN ('cutout', 'corrected_cutout')
        AND variant.processing_status = 'completed'
        AND variant.archived_at IS NULL
        AND COALESCE(variant.metadata ->> 'quality_class', 'good') <> 'needs_review'
    ) THEN
      already_completed_count := already_completed_count + 1;
      CONTINUE;
    END IF;

    retry_allowed := CASE
      WHEN target.failure_category = 'source_invalid' THEN false
      WHEN target.failure_category IN ('model_rejection', 'resource_failure')
        THEN target.deterministic_failure_count < 2
      WHEN target.failure_category IN ('transient', 'finalization_failure')
        THEN target.attempt_count < 25
      WHEN target.failure_category IS NULL THEN target.attempt_count < 2
      ELSE false
    END;
    IF NOT retry_allowed THEN
      not_retryable_count := not_retryable_count + 1;
      CONTINUE;
    END IF;

    item_result := public.retry_background_removal(target.id);
    IF item_result ->> 'status' = 'queued' THEN
      retried_count := retried_count + 1;
    ELSIF item_result ->> 'status' IN ('processing', 'running') THEN
      already_active_count := already_active_count + 1;
    ELSIF item_result ->> 'status' IN ('completed', 'succeeded') THEN
      already_completed_count := already_completed_count + 1;
    ELSE
      not_retryable_count := not_retryable_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'failed_count', failed_count,
    'retried_count', retried_count,
    'not_retryable_count', not_retryable_count,
    'already_active_count', already_active_count,
    'already_completed_count', already_completed_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_background_removals_for_vehicle(
  _dealership_id uuid,
  _vehicle_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target private.background_jobs%ROWTYPE;
  item_result jsonb;
  selected_count integer := 0;
  canceled_count integer := 0;
  cancel_requested_count integer := 0;
  already_canceled_count integer := 0;
BEGIN
  IF actor_id IS NULL
     OR NOT private.current_user_has_store_capability(_dealership_id, 'media') THEN
    RAISE EXCEPTION 'Vehicle background-removal cancellation is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.vehicles
    WHERE id = _vehicle_id AND dealership_id = _dealership_id
  ) THEN
    RAISE EXCEPTION 'Vehicle background-removal cancellation is unavailable.' USING ERRCODE = '22023';
  END IF;

  FOR target IN
    SELECT job.*
    FROM private.background_jobs AS job
    JOIN public.media_assets AS asset
      ON asset.id = job.resource_id
     AND job.resource_type = 'media_asset'
     AND asset.dealership_id = _dealership_id
     AND asset.vehicle_id = _vehicle_id
     AND asset.lifecycle_state = 'active'
    WHERE job.dealership_id = _dealership_id
      AND job.job_type = 'media.background.remove'
      AND job.status IN ('queued', 'retry_scheduled', 'running', 'dead_letter')
      AND job.cancel_requested_at IS NULL
    ORDER BY job.created_at, job.id
    FOR UPDATE OF job
  LOOP
    selected_count := selected_count + 1;
    item_result := public.cancel_background_removal(target.id);
    IF item_result ->> 'status' IN ('canceled', 'cancelled') THEN
      canceled_count := canceled_count + 1;
    ELSIF item_result ->> 'status' = 'cancel_requested' THEN
      cancel_requested_count := cancel_requested_count + 1;
    ELSE
      already_canceled_count := already_canceled_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'selected_count', selected_count,
    'canceled_count', canceled_count,
    'cancel_requested_count', cancel_requested_count,
    'already_canceled_count', already_canceled_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_background_removal_activity_grouped(uuid, integer)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.retry_failed_background_removals_for_vehicle(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_background_removals_for_vehicle(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_background_removal_activity_grouped(uuid, integer)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.retry_failed_background_removals_for_vehicle(uuid, uuid)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_background_removals_for_vehicle(uuid, uuid)
TO authenticated;

COMMENT ON FUNCTION public.get_background_removal_activity_grouped(uuid, integer) IS
  'Capability-authorized store activity grouped by vehicle with authoritative nested job detail.';
COMMENT ON FUNCTION public.retry_failed_background_removals_for_vehicle(uuid, uuid) IS
  'Capability-authorized idempotent retry of eligible failures for one store-owned vehicle.';
COMMENT ON FUNCTION public.cancel_background_removals_for_vehicle(uuid, uuid) IS
  'Capability-authorized cancellation of eligible background-removal work for one store-owned vehicle.';
