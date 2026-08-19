-- Classify repeated background-removal failures, retain safe mask diagnostics,
-- and preserve poor-but-usable masks as private drafts for Fix Cutout.

ALTER TABLE private.background_jobs
  ADD COLUMN IF NOT EXISTS failure_category text,
  ADD COLUMN IF NOT EXISTS failure_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS deterministic_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS draft_variant_id uuid REFERENCES public.media_variants(id) ON DELETE SET NULL;

ALTER TABLE private.background_jobs
  DROP CONSTRAINT IF EXISTS background_jobs_failure_category_check,
  DROP CONSTRAINT IF EXISTS background_jobs_failure_diagnostics_check,
  DROP CONSTRAINT IF EXISTS background_jobs_deterministic_failure_count_check;

ALTER TABLE private.background_jobs
  ADD CONSTRAINT background_jobs_failure_category_check CHECK (
    failure_category IS NULL OR failure_category IN (
      'transient', 'source_invalid', 'model_rejection', 'resource_failure',
      'finalization_failure'
    )
  ),
  ADD CONSTRAINT background_jobs_failure_diagnostics_check CHECK (
    jsonb_typeof(failure_diagnostics) = 'object'
    AND octet_length(failure_diagnostics::text) <= 16384
  ),
  ADD CONSTRAINT background_jobs_deterministic_failure_count_check CHECK (
    deterministic_failure_count BETWEEN 0 AND 25
  );

ALTER TABLE private.background_job_attempts
  ADD COLUMN IF NOT EXISTS failure_category text,
  ADD COLUMN IF NOT EXISTS safe_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE private.background_job_attempts
  DROP CONSTRAINT IF EXISTS background_job_attempts_failure_category_check,
  DROP CONSTRAINT IF EXISTS background_job_attempts_safe_diagnostics_check;

ALTER TABLE private.background_job_attempts
  ADD CONSTRAINT background_job_attempts_failure_category_check CHECK (
    failure_category IS NULL OR failure_category IN (
      'transient', 'source_invalid', 'model_rejection', 'resource_failure',
      'finalization_failure'
    )
  ),
  ADD CONSTRAINT background_job_attempts_safe_diagnostics_check CHECK (
    jsonb_typeof(safe_diagnostics) = 'object'
    AND octet_length(safe_diagnostics::text) <= 16384
  );

CREATE OR REPLACE FUNCTION public.worker_fail_background_job_diagnostic(
  _worker_id text,
  _job_id uuid,
  _safe_error_code text,
  _retryable boolean,
  _failure_category text,
  _safe_diagnostics jsonb DEFAULT '{}'::jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job private.background_jobs%ROWTYPE;
  next_status text;
  next_deterministic_count integer;
  deterministic boolean;
BEGIN
  IF _failure_category NOT IN (
       'transient', 'source_invalid', 'model_rejection', 'resource_failure',
       'finalization_failure'
     )
     OR jsonb_typeof(COALESCE(_safe_diagnostics, '{}'::jsonb)) <> 'object'
     OR octet_length(COALESCE(_safe_diagnostics, '{}'::jsonb)::text) > 16384 THEN
    RAISE EXCEPTION 'Invalid background-removal failure details.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO job
  FROM private.background_jobs
  WHERE id = _job_id AND status = 'running' AND lease_owner = _worker_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_owned'; END IF;

  deterministic := _failure_category IN ('source_invalid', 'model_rejection', 'resource_failure');
  next_deterministic_count := CASE
    WHEN NOT deterministic THEN 0
    WHEN job.failure_category = _failure_category
      AND job.last_error_code = left(COALESCE(_safe_error_code, 'unknown_error'), 120)
      THEN LEAST(25, job.deterministic_failure_count + 1)
    ELSE 1
  END;

  next_status := CASE
    WHEN job.cancel_requested_at IS NOT NULL THEN 'cancelled'
    WHEN _retryable AND job.attempt_count < job.max_attempts THEN 'retry_scheduled'
    ELSE 'dead_letter'
  END;

  UPDATE private.background_jobs
  SET status = next_status,
      available_at = CASE WHEN next_status = 'retry_scheduled'
        THEN now() + make_interval(secs => LEAST(300, (5 * power(2, job.attempt_count - 1))::integer))
        ELSE available_at END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = CASE WHEN next_status = 'cancelled' THEN NULL
        ELSE left(COALESCE(_safe_error_code, 'unknown_error'), 120) END,
      failure_category = CASE WHEN next_status = 'cancelled' THEN failure_category
        ELSE _failure_category END,
      failure_diagnostics = CASE WHEN next_status = 'cancelled' THEN failure_diagnostics
        ELSE COALESCE(_safe_diagnostics, '{}'::jsonb) END,
      deterministic_failure_count = CASE WHEN next_status = 'cancelled'
        THEN deterministic_failure_count ELSE next_deterministic_count END,
      updated_at = now(),
      completed_at = CASE WHEN next_status IN ('dead_letter', 'cancelled') THEN now() ELSE NULL END,
      cancelled_at = CASE WHEN next_status = 'cancelled' THEN COALESCE(cancelled_at, now())
        ELSE cancelled_at END
  WHERE id = job.id;

  UPDATE private.background_job_attempts
  SET outcome = next_status,
      safe_error_code = CASE WHEN next_status = 'cancelled' THEN NULL
        ELSE left(COALESCE(_safe_error_code, 'unknown_error'), 120) END,
      failure_category = CASE WHEN next_status = 'cancelled' THEN NULL
        ELSE _failure_category END,
      safe_diagnostics = CASE WHEN next_status = 'cancelled' THEN '{}'::jsonb
        ELSE COALESCE(_safe_diagnostics, '{}'::jsonb) END,
      completed_at = now()
  WHERE job_id = job.id AND attempt_number = job.attempt_count AND outcome = 'running';

  RETURN next_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_commit_background_cutout_result(
  _job_id uuid,
  _variant_id uuid,
  _storage_bucket text,
  _storage_path text,
  _byte_size bigint,
  _width integer,
  _height integer,
  _checksum_sha256 text,
  _quality_class text,
  _diagnostics jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source jsonb;
  result_id uuid;
  previous_category text;
  previous_count integer;
BEGIN
  SELECT failure_category, deterministic_failure_count
  INTO previous_category, previous_count
  FROM private.background_jobs
  WHERE id = _job_id
    AND job_type = 'media.background.remove'
    AND status = 'running'
    AND cancel_requested_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Background removal is no longer active.' USING ERRCODE = '55000';
  END IF;

  source := public.worker_get_background_removal_source(_job_id);
  IF source IS NULL OR _storage_bucket <> 'dealer-media-private'
     OR _storage_path NOT LIKE 'stores/' || (source->>'dealership_id') || '/vehicles/' ||
       (source->>'vehicle_id') || '/media/' || (source->>'media_asset_id') || '/variants/cutout/%'
     OR _byte_size NOT BETWEEN 1 AND 26214400 OR _width < 1 OR _height < 1
     OR _checksum_sha256 !~ '^[0-9a-f]{64}$'
     OR _quality_class NOT IN ('good', 'needs_review')
     OR jsonb_typeof(COALESCE(_diagnostics, '{}'::jsonb)) <> 'object'
     OR octet_length(COALESCE(_diagnostics, '{}'::jsonb)::text) > 16384 THEN
    RAISE EXCEPTION 'Invalid background-removal result.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.media_variants (
    id, photo_id, media_asset_id, variant_type, source_variant_id, image_url,
    storage_bucket, storage_path, content_type, processing_provider, processing_status,
    width, height, byte_size, checksum, variant_role, created_by, metadata
  ) VALUES (
    _variant_id, (source->>'photo_id')::uuid, (source->>'media_asset_id')::uuid, 'cutout',
    (source->>'source_variant_id')::uuid, 'private-media://' || _variant_id,
    _storage_bucket, _storage_path, 'image/png', 'dealershot-isnet-node', 'completed',
    _width, _height, _byte_size, _checksum_sha256,
    CASE WHEN _quality_class = 'good' THEN 'prepared' ELSE 'draft' END,
    (source->>'actor_id')::uuid,
    jsonb_build_object(
      'operation', 'background_remove',
      'job_id', _job_id,
      'quality_class', _quality_class,
      'mask_diagnostics', COALESCE(_diagnostics, '{}'::jsonb),
      'auto_promoted', _quality_class = 'good',
      'source_normalized', true,
      'exif_orientation_applied', true
    )
  )
  RETURNING id INTO result_id;

  IF _quality_class = 'good' THEN
    UPDATE public.photos
    SET image_url = 'private-media://' || result_id,
        approved_variant_id = result_id,
        cutout_image_url = 'private-media://' || result_id,
        is_cutout = true,
        cutout_status = 'done',
        photo_state = 'cutout',
        processing_action = 'background_replace',
        processing_status = 'completed',
        processing_provider = 'dealershot-isnet-node',
        processing_error = NULL,
        review_status = 'awaiting_review',
        updated_at = now()
    WHERE id = (source->>'photo_id')::uuid;

    UPDATE private.background_jobs
    SET failure_category = NULL,
        failure_diagnostics = '{}'::jsonb,
        deterministic_failure_count = 0,
        draft_variant_id = NULL,
        updated_at = now()
    WHERE id = _job_id;
  ELSE
    UPDATE public.photos
    SET cutout_image_url = 'private-media://' || result_id,
        is_cutout = true,
        cutout_status = 'needs_review',
        processing_action = 'manual_review',
        processing_status = 'completed',
        processing_provider = 'dealershot-isnet-node',
        processing_error = 'mask_quality_needs_review',
        review_status = 'awaiting_review',
        updated_at = now()
    WHERE id = (source->>'photo_id')::uuid;

    UPDATE private.background_jobs
    SET failure_category = 'model_rejection',
        failure_diagnostics = COALESCE(_diagnostics, '{}'::jsonb),
        deterministic_failure_count = CASE WHEN previous_category = 'model_rejection'
          THEN LEAST(25, previous_count + 1) ELSE 1 END,
        draft_variant_id = result_id,
        updated_at = now()
    WHERE id = _job_id;
  END IF;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES (
    'vehicle_media.variant_created', (source->>'actor_id')::uuid,
    (source->>'dealership_id')::uuid,
    jsonb_build_object(
      'vehicle_id', (source->>'vehicle_id')::uuid,
      'photo_id', (source->>'photo_id')::uuid,
      'media_asset_id', (source->>'media_asset_id')::uuid,
      'variant_id', result_id,
      'variant_type', 'cutout',
      'job_id', _job_id,
      'quality_class', _quality_class,
      'auto_promoted', _quality_class = 'good'
    )
  );
  RETURN result_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.retry_background_removal(_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  job private.background_jobs%ROWTYPE;
  media_store_id uuid;
  media_vehicle_id uuid;
  good_variant_exists boolean;
  retry_allowed boolean;
BEGIN
  SELECT target.* INTO job
  FROM private.background_jobs AS target
  WHERE target.id = _job_id AND target.job_type = 'media.background.remove'
  FOR UPDATE OF target;

  SELECT asset.dealership_id, asset.vehicle_id
  INTO media_store_id, media_vehicle_id
  FROM public.media_assets AS asset
  WHERE asset.id = job.resource_id
    AND job.resource_type = 'media_asset'
    AND asset.lifecycle_state = 'active';

  IF actor_id IS NULL OR job.id IS NULL OR media_store_id <> job.dealership_id
     OR NOT private.current_user_has_store_capability(media_store_id, 'media') THEN
    RAISE EXCEPTION 'Background-removal retry is unavailable.' USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.media_variants AS variant
    WHERE variant.media_asset_id = job.resource_id
      AND variant.variant_type IN ('cutout', 'corrected_cutout')
      AND variant.processing_status = 'completed'
      AND variant.archived_at IS NULL
      AND variant.metadata ->> 'job_id' = job.id::text
      AND COALESCE(variant.metadata ->> 'quality_class', 'good') <> 'needs_review'
  ) INTO good_variant_exists;

  IF good_variant_exists THEN
    UPDATE private.background_jobs
    SET status = 'succeeded', completed_at = COALESCE(completed_at, now()),
        lease_owner = NULL, lease_expires_at = NULL,
        cancel_requested_at = NULL, cancel_requested_by = NULL, updated_at = now()
    WHERE id = job.id AND status <> 'succeeded';
    RETURN jsonb_build_object('job_id', job.id, 'status', 'completed', 'reused', true);
  END IF;

  IF job.status IN ('queued', 'retry_scheduled', 'running')
     AND job.cancel_requested_at IS NULL THEN
    RETURN jsonb_build_object(
      'job_id', job.id,
      'status', CASE WHEN job.status = 'running' THEN 'processing' ELSE 'queued' END,
      'reused', true
    );
  END IF;

  retry_allowed := CASE
    WHEN job.failure_category = 'source_invalid' THEN false
    WHEN job.failure_category IN ('model_rejection', 'resource_failure')
      THEN job.deterministic_failure_count < 2
    WHEN job.failure_category IN ('transient', 'finalization_failure')
      THEN job.attempt_count < 25
    WHEN job.failure_category IS NULL THEN job.attempt_count < 2
    ELSE false
  END;

  IF job.status NOT IN ('dead_letter', 'cancelled', 'succeeded') OR NOT retry_allowed THEN
    RETURN jsonb_build_object(
      'job_id', job.id, 'status',
      CASE WHEN job.draft_variant_id IS NOT NULL THEN 'needs_review' ELSE job.status END,
      'retryable', false,
      'has_draft', job.draft_variant_id IS NOT NULL
    );
  END IF;

  UPDATE private.background_jobs
  SET status = 'queued',
      available_at = now(),
      max_attempts = LEAST(25, GREATEST(max_attempts, attempt_count + 1)),
      lease_owner = NULL,
      lease_expires_at = NULL,
      completed_at = NULL,
      cancelled_at = NULL,
      cancel_requested_at = NULL,
      cancel_requested_by = NULL,
      last_error_message = NULL,
      safe_result = NULL,
      created_by = actor_id,
      updated_at = now()
  WHERE id = job.id;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES (
    'vehicle_media.background_removal_retried', actor_id, media_store_id,
    jsonb_build_object(
      'job_id', job.id,
      'media_asset_id', job.resource_id,
      'vehicle_id', media_vehicle_id,
      'previous_status', job.status,
      'previous_attempt_count', job.attempt_count,
      'failure_category', job.failure_category,
      'deterministic_failure_count', job.deterministic_failure_count
    )
  );

  RETURN jsonb_build_object('job_id', job.id, 'status', 'queued', 'reused', true);
END;
$$;

CREATE OR REPLACE FUNCTION private.ensure_background_removal_job(
  _dealership_id uuid,
  _media_asset_id uuid,
  _photo_id uuid,
  _actor_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job private.background_jobs%ROWTYPE;
  retry_allowed boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.media_assets AS asset
    JOIN public.photos AS photo ON photo.media_asset_id = asset.id
    WHERE asset.id = _media_asset_id
      AND asset.dealership_id = _dealership_id
      AND asset.lifecycle_state = 'active'
      AND photo.id = _photo_id
  ) THEN
    RAISE EXCEPTION 'Background-removal media is unavailable.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO job
  FROM private.background_jobs
  WHERE job_type = 'media.background.remove'
    AND dedupe_key = 'background-remove:' || _media_asset_id || ':v1'
  FOR UPDATE;

  IF FOUND THEN
    IF job.status IN ('queued', 'running', 'retry_scheduled')
       OR EXISTS (
         SELECT 1
         FROM public.media_variants AS variant
         WHERE variant.media_asset_id = _media_asset_id
           AND variant.variant_type IN ('cutout', 'corrected_cutout')
           AND variant.processing_status = 'completed'
           AND variant.archived_at IS NULL
           AND COALESCE(variant.metadata ->> 'quality_class', 'good') <> 'needs_review'
       ) THEN
      RETURN NULL;
    END IF;

    retry_allowed := CASE
      WHEN job.failure_category = 'source_invalid' THEN false
      WHEN job.failure_category IN ('model_rejection', 'resource_failure')
        THEN job.deterministic_failure_count < 2
      WHEN job.failure_category IN ('transient', 'finalization_failure')
        THEN job.attempt_count < 25
      WHEN job.failure_category IS NULL THEN job.attempt_count < 2
      ELSE false
    END;

    IF job.status IN ('dead_letter', 'cancelled', 'succeeded') AND retry_allowed THEN
      UPDATE private.background_jobs
      SET status = 'queued', available_at = now(),
          max_attempts = LEAST(25, GREATEST(max_attempts, attempt_count + 1)),
          lease_owner = NULL, lease_expires_at = NULL, completed_at = NULL,
          cancelled_at = NULL, cancel_requested_at = NULL, cancel_requested_by = NULL,
          last_error_message = NULL, safe_result = NULL,
          created_by = _actor_id, updated_at = now()
      WHERE id = job.id;
      RETURN job.id;
    END IF;
    RETURN NULL;
  END IF;

  INSERT INTO private.background_jobs (
    job_type, payload, dealership_id, resource_type, resource_id, dedupe_key,
    max_attempts, priority, created_by
  ) VALUES (
    'media.background.remove',
    jsonb_build_object('media_asset_id', _media_asset_id, 'photo_id', _photo_id),
    _dealership_id, 'media_asset', _media_asset_id,
    'background-remove:' || _media_asset_id || ':v1', 3, 30, _actor_id
  ) RETURNING * INTO job;
  RETURN job.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_background_removal_activity(
  _dealership_id uuid,
  _limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'media') THEN
    RAISE EXCEPTION 'Background processing activity is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF _limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Invalid activity limit.' USING ERRCODE = '22023';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(activity) ORDER BY activity.created_at DESC)
    FROM (
      SELECT
        job.id AS job_id,
        job.resource_id AS media_asset_id,
        NULLIF(job.payload ->> 'photo_id', '')::uuid AS photo_id,
        asset.vehicle_id,
        vehicle.stock_number,
        concat_ws(' ', vehicle.year::text, NULLIF(vehicle.make, ''), NULLIF(vehicle.model, ''))
          AS vehicle_label,
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
        job.updated_at
      FROM private.background_jobs AS job
      LEFT JOIN public.media_assets AS asset
        ON asset.id = job.resource_id AND job.resource_type = 'media_asset'
      LEFT JOIN public.vehicles AS vehicle
        ON vehicle.id = asset.vehicle_id AND vehicle.dealership_id = _dealership_id
      WHERE job.dealership_id = _dealership_id
        AND job.job_type = 'media.background.remove'
        AND (
          job.status IN ('queued', 'running', 'retry_scheduled')
          OR (job.status = 'succeeded' AND job.completed_at >= now() - interval '1 hour')
          OR (job.status = 'succeeded' AND job.draft_variant_id IS NOT NULL)
          OR (job.status = 'dead_letter' AND job.completed_at >= now() - interval '7 days')
          OR (job.status = 'cancelled' AND job.completed_at >= now() - interval '1 hour')
        )
      ORDER BY job.created_at DESC
      LIMIT _limit
    ) AS activity
  ), '[]'::jsonb);
END;
$$;

-- Legacy worker errors were collapsed to `error`/`background_inference_failed`.
-- All hosted attempts in that cohort failed before inference could complete and
-- the deployed Alpine image cannot load ONNX Runtime's glibc-linked binary.
UPDATE private.background_jobs
SET failure_category = 'resource_failure',
    failure_diagnostics = jsonb_build_object(
      'safe_code', 'production_runtime_incompatible',
      'runtime', 'linux_musl',
      'required_runtime', 'linux_glibc'
    ),
    deterministic_failure_count = LEAST(25, GREATEST(2, attempt_count)),
    updated_at = now()
WHERE job_type = 'media.background.remove'
  AND last_error_code IN ('error', 'background_inference_failed')
  AND status IN ('dead_letter', 'cancelled')
  AND failure_category IS NULL;

UPDATE private.background_job_attempts AS attempt
SET failure_category = 'resource_failure',
    safe_diagnostics = jsonb_build_object('safe_code', 'production_runtime_incompatible')
FROM private.background_jobs AS job
WHERE job.id = attempt.job_id
  AND job.job_type = 'media.background.remove'
  AND attempt.safe_error_code IN ('error', 'background_inference_failed')
  AND attempt.failure_category IS NULL;

REVOKE ALL ON FUNCTION public.worker_fail_background_job_diagnostic(
  text, uuid, text, boolean, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_commit_background_cutout_result(
  uuid, uuid, text, text, bigint, integer, integer, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ensure_background_removal_job(uuid, uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.retry_background_removal(uuid)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_background_removal_activity(uuid, integer)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.worker_fail_background_job_diagnostic(
  text, uuid, text, boolean, text, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_commit_background_cutout_result(
  uuid, uuid, text, text, bigint, integer, integer, text, text, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_background_removal(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_background_removal_activity(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.worker_fail_background_job_diagnostic(
  text, uuid, text, boolean, text, jsonb
) IS 'Records a safe background-removal failure category and bounded diagnostics while preserving attempt history.';
COMMENT ON FUNCTION public.worker_commit_background_cutout_result(
  uuid, uuid, text, text, bigint, integer, integer, text, text, jsonb
) IS 'Commits a good ISNet cutout or a private needs-review draft without overwriting the immutable original.';
