-- Keep user-facing photo processing state synchronized with the authoritative
-- durable background-removal job, and expose capability-authorized retry and
-- cancel controls without granting browser roles access to the private queue.

ALTER TABLE private.background_jobs
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE private.background_job_attempts
  DROP CONSTRAINT IF EXISTS background_job_attempts_outcome_check;

ALTER TABLE private.background_job_attempts
  ADD CONSTRAINT background_job_attempts_outcome_check
  CHECK (outcome IN (
    'running', 'succeeded', 'retry_scheduled', 'dead_letter', 'lease_expired', 'cancelled'
  ));

CREATE OR REPLACE FUNCTION private.sync_background_removal_photo_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.job_type <> 'media.background.remove'
     OR NEW.resource_type <> 'media_asset'
     OR NEW.resource_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.photos AS photo
  SET processing_action = CASE
        WHEN NEW.status = 'cancelled' OR NEW.cancel_requested_at IS NOT NULL
          THEN 'keep_original'
        ELSE 'background_replace'
      END,
      processing_status = CASE
        WHEN NEW.status = 'cancelled' OR NEW.cancel_requested_at IS NOT NULL
          THEN 'not_required'
        WHEN NEW.status IN ('queued', 'retry_scheduled') THEN 'queued'
        WHEN NEW.status = 'running' THEN 'processing'
        WHEN NEW.status = 'succeeded' AND EXISTS (
          SELECT 1
          FROM public.media_variants AS variant
          WHERE variant.media_asset_id = NEW.resource_id
            AND variant.variant_type IN ('cutout', 'corrected_cutout')
            AND variant.processing_status = 'completed'
            AND variant.archived_at IS NULL
        ) THEN 'completed'
        WHEN NEW.status = 'succeeded' THEN photo.processing_status
        WHEN NEW.status = 'dead_letter' THEN 'failed'
        ELSE photo.processing_status
      END,
      processing_error = CASE
        WHEN NEW.status = 'dead_letter' THEN 'background_removal_failed'
        WHEN NEW.status = 'succeeded' AND NOT EXISTS (
          SELECT 1
          FROM public.media_variants AS variant
          WHERE variant.media_asset_id = NEW.resource_id
            AND variant.variant_type IN ('cutout', 'corrected_cutout')
            AND variant.processing_status = 'completed'
            AND variant.archived_at IS NULL
        ) THEN photo.processing_error
        WHEN NEW.status IN ('queued', 'retry_scheduled', 'running', 'succeeded', 'cancelled')
          OR NEW.cancel_requested_at IS NOT NULL THEN NULL
        ELSE photo.processing_error
      END,
      updated_at = now()
  WHERE photo.media_asset_id = NEW.resource_id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.sync_background_removal_photo_state()
FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS background_jobs_sync_photo_state ON private.background_jobs;
CREATE TRIGGER background_jobs_sync_photo_state
AFTER INSERT OR UPDATE OF status, cancel_requested_at ON private.background_jobs
FOR EACH ROW EXECUTE FUNCTION private.sync_background_removal_photo_state();

-- Reconcile only the latest durable background-removal request for each media
-- asset. This repairs existing terminal jobs whose photos were left queued or
-- processing, without touching other processing operation types.
WITH latest AS (
  SELECT DISTINCT ON (job.resource_id)
    job.resource_id,
    job.status,
    job.cancel_requested_at
  FROM private.background_jobs AS job
  WHERE job.job_type = 'media.background.remove'
    AND job.resource_type = 'media_asset'
    AND job.resource_id IS NOT NULL
  ORDER BY job.resource_id, job.created_at DESC, job.id DESC
)
UPDATE public.photos AS photo
SET processing_action = CASE
      WHEN latest.status = 'cancelled' OR latest.cancel_requested_at IS NOT NULL
        THEN 'keep_original'
      ELSE 'background_replace'
    END,
    processing_status = CASE
      WHEN latest.status = 'cancelled' OR latest.cancel_requested_at IS NOT NULL
        THEN 'not_required'
      WHEN latest.status IN ('queued', 'retry_scheduled') THEN 'queued'
      WHEN latest.status = 'running' THEN 'processing'
      WHEN latest.status = 'succeeded' AND EXISTS (
        SELECT 1
        FROM public.media_variants AS variant
        WHERE variant.media_asset_id = latest.resource_id
          AND variant.variant_type IN ('cutout', 'corrected_cutout')
          AND variant.processing_status = 'completed'
          AND variant.archived_at IS NULL
      ) THEN 'completed'
      WHEN latest.status = 'succeeded' THEN photo.processing_status
      WHEN latest.status = 'dead_letter' THEN 'failed'
      ELSE photo.processing_status
    END,
    processing_error = CASE
      WHEN latest.status = 'dead_letter' THEN 'background_removal_failed'
      ELSE NULL
    END,
    updated_at = now()
FROM latest
WHERE photo.media_asset_id = latest.resource_id
  AND (
    photo.processing_status IS DISTINCT FROM CASE
      WHEN latest.status = 'cancelled' OR latest.cancel_requested_at IS NOT NULL
        THEN 'not_required'
      WHEN latest.status IN ('queued', 'retry_scheduled') THEN 'queued'
      WHEN latest.status = 'running' THEN 'processing'
      WHEN latest.status = 'succeeded' AND EXISTS (
        SELECT 1
        FROM public.media_variants AS variant
        WHERE variant.media_asset_id = latest.resource_id
          AND variant.variant_type IN ('cutout', 'corrected_cutout')
          AND variant.processing_status = 'completed'
          AND variant.archived_at IS NULL
      ) THEN 'completed'
      WHEN latest.status = 'succeeded' THEN photo.processing_status
      WHEN latest.status = 'dead_letter' THEN 'failed'
      ELSE photo.processing_status
    END
    OR (latest.status = 'dead_letter' AND photo.processing_error IS DISTINCT FROM 'background_removal_failed')
  );

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
    IF job.status IN ('queued', 'running', 'retry_scheduled', 'succeeded')
       OR EXISTS (
         SELECT 1
         FROM public.media_variants AS variant
         WHERE variant.media_asset_id = _media_asset_id
           AND variant.variant_type IN ('cutout', 'corrected_cutout')
           AND variant.processing_status = 'completed'
           AND variant.archived_at IS NULL
       ) THEN
      RETURN NULL;
    END IF;

    IF job.status IN ('dead_letter', 'cancelled') THEN
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
          last_error_code = NULL,
          last_error_message = NULL,
          safe_result = NULL,
          created_by = _actor_id,
          updated_at = now()
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
  )
  RETURNING * INTO job;

  RETURN job.id;
END;
$$;

REVOKE ALL ON FUNCTION private.ensure_background_removal_job(uuid, uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

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
BEGIN
  SELECT target.* INTO job
  FROM private.background_jobs AS target
  WHERE target.id = _job_id
    AND target.job_type = 'media.background.remove'
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

  IF EXISTS (
    SELECT 1
    FROM public.media_variants AS variant
    WHERE variant.media_asset_id = job.resource_id
      AND variant.variant_type IN ('cutout', 'corrected_cutout')
      AND variant.processing_status = 'completed'
      AND variant.archived_at IS NULL
      AND variant.metadata ->> 'job_id' = job.id::text
  ) THEN
    UPDATE private.background_jobs
    SET status = 'succeeded',
        completed_at = COALESCE(completed_at, now()),
        lease_owner = NULL,
        lease_expires_at = NULL,
        cancel_requested_at = NULL,
        cancel_requested_by = NULL,
        updated_at = now()
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

  IF job.status NOT IN ('dead_letter', 'cancelled')
     OR job.attempt_count >= 25 THEN
    RETURN jsonb_build_object('job_id', job.id, 'status', job.status, 'retryable', false);
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
      last_error_code = NULL,
      last_error_message = NULL,
      safe_result = NULL,
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
      'previous_attempt_count', job.attempt_count
    )
  );

  RETURN jsonb_build_object('job_id', job.id, 'status', 'queued', 'reused', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_background_removal(_job_id uuid)
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
  result_status text;
BEGIN
  SELECT target.* INTO job
  FROM private.background_jobs AS target
  WHERE target.id = _job_id
    AND target.job_type = 'media.background.remove'
  FOR UPDATE OF target;

  SELECT asset.dealership_id, asset.vehicle_id
  INTO media_store_id, media_vehicle_id
  FROM public.media_assets AS asset
  WHERE asset.id = job.resource_id
    AND job.resource_type = 'media_asset'
    AND asset.lifecycle_state = 'active';

  IF actor_id IS NULL OR job.id IS NULL OR media_store_id <> job.dealership_id
     OR NOT private.current_user_has_store_capability(media_store_id, 'media') THEN
    RAISE EXCEPTION 'Background-removal cancellation is unavailable.' USING ERRCODE = '42501';
  END IF;

  IF job.status = 'succeeded' OR EXISTS (
    SELECT 1
    FROM public.media_variants AS variant
    WHERE variant.media_asset_id = job.resource_id
      AND variant.variant_type IN ('cutout', 'corrected_cutout')
      AND variant.processing_status = 'completed'
      AND variant.archived_at IS NULL
      AND variant.metadata ->> 'job_id' = job.id::text
  ) THEN
    RETURN jsonb_build_object('job_id', job.id, 'status', 'completed', 'cancelable', false);
  END IF;

  IF job.status = 'cancelled' OR job.cancel_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('job_id', job.id, 'status', 'canceled', 'reused', true);
  END IF;

  IF job.status IN ('queued', 'retry_scheduled', 'dead_letter') THEN
    UPDATE private.background_jobs
    SET status = 'cancelled',
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = now(),
        cancelled_at = now(),
        cancel_requested_at = now(),
        cancel_requested_by = actor_id,
        updated_at = now()
    WHERE id = job.id;
    result_status := 'canceled';
  ELSIF job.status = 'running' THEN
    UPDATE private.background_jobs
    SET cancel_requested_at = now(),
        cancel_requested_by = actor_id,
        updated_at = now()
    WHERE id = job.id;
    result_status := 'cancel_requested';
  ELSE
    RETURN jsonb_build_object('job_id', job.id, 'status', job.status, 'cancelable', false);
  END IF;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES (
    'vehicle_media.background_removal_cancelled', actor_id, media_store_id,
    jsonb_build_object(
      'job_id', job.id,
      'media_asset_id', job.resource_id,
      'vehicle_id', media_vehicle_id,
      'previous_status', job.status,
      'result_status', result_status
    )
  );

  RETURN jsonb_build_object('job_id', job.id, 'status', result_status, 'reused', false);
END;
$$;

REVOKE ALL ON FUNCTION public.retry_background_removal(uuid)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_background_removal(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retry_background_removal(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_background_removal(uuid) TO authenticated;

COMMENT ON FUNCTION public.retry_background_removal(uuid) IS
  'Capability-authorized and idempotent manual retry for one failed private-media background-removal job.';
COMMENT ON FUNCTION public.cancel_background_removal(uuid) IS
  'Capability-authorized cancellation request for one private-media background-removal job; immutable originals are never removed.';

CREATE OR REPLACE FUNCTION public.worker_get_background_removal_source(_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'job_id', job.id, 'actor_id', job.created_by, 'media_asset_id', asset.id,
    'dealership_id', asset.dealership_id, 'vehicle_id', asset.vehicle_id,
    'photo_id', photo.id, 'source_variant_id', variant.id,
    'bucket', variant.storage_bucket, 'path', variant.storage_path,
    'content_type', variant.content_type
  )
  FROM private.background_jobs AS job
  JOIN public.media_assets AS asset ON asset.id = job.resource_id
  JOIN public.photos AS photo ON photo.media_asset_id = asset.id
  JOIN public.media_variants AS variant ON variant.media_asset_id = asset.id
    AND variant.variant_type = 'original' AND variant.archived_at IS NULL
  WHERE job.id = _job_id
    AND job.job_type = 'media.background.remove'
    AND job.status = 'running'
    AND job.cancel_requested_at IS NULL
    AND asset.lifecycle_state = 'active'
    AND asset.vehicle_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.worker_commit_background_cutout(
  _job_id uuid,
  _variant_id uuid,
  _storage_bucket text,
  _storage_path text,
  _byte_size bigint,
  _width integer,
  _height integer,
  _checksum_sha256 text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source jsonb;
  result_id uuid;
BEGIN
  PERFORM 1
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
     OR _checksum_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid background-removal output.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.media_variants (
    id, photo_id, media_asset_id, variant_type, source_variant_id, image_url,
    storage_bucket, storage_path, content_type, processing_provider, processing_status,
    width, height, byte_size, checksum, variant_role, created_by, metadata
  ) VALUES (
    _variant_id, (source->>'photo_id')::uuid, (source->>'media_asset_id')::uuid, 'cutout',
    (source->>'source_variant_id')::uuid, 'private-media://' || _variant_id,
    _storage_bucket, _storage_path, 'image/png', 'dealershot-imgly-node', 'completed',
    _width, _height, _byte_size, _checksum_sha256, 'prepared', (source->>'actor_id')::uuid,
    jsonb_build_object('operation', 'background_remove', 'job_id', _job_id)
  ) ON CONFLICT (storage_bucket, storage_path)
    WHERE storage_bucket IS NOT NULL AND storage_path IS NOT NULL
    DO UPDATE SET processing_status = 'completed', byte_size = EXCLUDED.byte_size,
      width = EXCLUDED.width, height = EXCLUDED.height, checksum = EXCLUDED.checksum
    RETURNING id INTO result_id;

  UPDATE public.photos
  SET image_url = 'private-media://' || result_id,
      approved_variant_id = result_id,
      cutout_image_url = 'private-media://' || result_id,
      is_cutout = true,
      cutout_status = 'done',
      photo_state = 'cutout',
      processing_action = 'background_replace',
      processing_status = 'completed',
      processing_provider = 'dealershot-imgly-node',
      processing_error = NULL,
      review_status = 'awaiting_review',
      updated_at = now()
  WHERE id = (source->>'photo_id')::uuid;

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
      'job_id', _job_id
    )
  );
  RETURN result_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_complete_background_job(
  _worker_id text,
  _job_id uuid,
  _safe_result jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  attempt integer;
BEGIN
  UPDATE private.background_jobs
  SET status = 'succeeded', safe_result = _safe_result,
      lease_owner = NULL, lease_expires_at = NULL,
      updated_at = now(), completed_at = now()
  WHERE id = _job_id
    AND status = 'running'
    AND lease_owner = _worker_id
    AND cancel_requested_at IS NULL
  RETURNING attempt_count INTO attempt;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE private.background_job_attempts
  SET outcome = 'succeeded', completed_at = now()
  WHERE job_id = _job_id AND attempt_number = attempt AND outcome = 'running';
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_fail_background_job(
  _worker_id text,
  _job_id uuid,
  _safe_error_code text,
  _retryable boolean DEFAULT true
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job private.background_jobs%ROWTYPE;
  next_status text;
BEGIN
  SELECT * INTO job
  FROM private.background_jobs
  WHERE id = _job_id AND status = 'running' AND lease_owner = _worker_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_owned'; END IF;

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
      updated_at = now(),
      completed_at = CASE WHEN next_status IN ('dead_letter', 'cancelled') THEN now() ELSE NULL END,
      cancelled_at = CASE WHEN next_status = 'cancelled' THEN COALESCE(cancelled_at, now())
        ELSE cancelled_at END
  WHERE id = job.id;

  UPDATE private.background_job_attempts
  SET outcome = next_status,
      safe_error_code = CASE WHEN next_status = 'cancelled' THEN NULL
        ELSE left(COALESCE(_safe_error_code, 'unknown_error'), 120) END,
      completed_at = now()
  WHERE job_id = job.id AND attempt_number = job.attempt_count AND outcome = 'running';

  RETURN next_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_vehicle_background_removal(
  _vehicle_id uuid,
  _media_asset_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.vehicles;
  photo record;
  selected_count integer := COALESCE(cardinality(_media_asset_ids), 0);
  queued_count integer := 0;
  skipped_count integer := 0;
  queued_job_id uuid;
BEGIN
  SELECT * INTO target FROM public.vehicles WHERE id = _vehicle_id;
  IF actor_id IS NULL OR target.id IS NULL
     OR NOT private.current_user_has_store_capability(target.dealership_id, 'media') THEN
    RAISE EXCEPTION 'Vehicle photo review is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF selected_count > 100 THEN
    RAISE EXCEPTION 'Select no more than 100 photos.' USING ERRCODE = '22023';
  END IF;
  IF selected_count <> COALESCE(
    (SELECT count(DISTINCT media_id) FROM unnest(_media_asset_ids) AS media_id), 0
  ) THEN
    RAISE EXCEPTION 'Background processing selection contains duplicates.' USING ERRCODE = '22023';
  END IF;

  FOR photo IN
    SELECT p.id AS photo_id, p.media_asset_id
    FROM public.photos AS p
    JOIN public.media_assets AS asset ON asset.id = p.media_asset_id
    WHERE p.vehicle_id = target.id
      AND p.media_asset_id = ANY(COALESCE(_media_asset_ids, ARRAY[]::uuid[]))
      AND asset.vehicle_id = target.id
      AND asset.lifecycle_state = 'active'
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.media_variants AS variant
      WHERE variant.media_asset_id = photo.media_asset_id
        AND variant.variant_type IN ('cutout', 'corrected_cutout')
        AND variant.processing_status = 'completed'
        AND variant.archived_at IS NULL
    ) THEN
      skipped_count := skipped_count + 1;
      CONTINUE;
    END IF;

    queued_job_id := private.ensure_background_removal_job(
      target.dealership_id, photo.media_asset_id, photo.photo_id, actor_id
    );
    IF queued_job_id IS NULL THEN
      skipped_count := skipped_count + 1;
    ELSE
      queued_count := queued_count + 1;
    END IF;
  END LOOP;

  skipped_count := skipped_count + GREATEST(selected_count - queued_count - skipped_count, 0);
  IF selected_count > 0 THEN
    INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
    VALUES (
      'vehicle_photo.review_processing_selected', actor_id, target.dealership_id,
      jsonb_build_object(
        'vehicle_id', target.id,
        'selected_count', selected_count,
        'queued_count', queued_count,
        'skipped_count', skipped_count
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'selected_count', selected_count,
    'queued_count', queued_count,
    'skipped_count', skipped_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_bulk_background_removal(
  _session_id uuid,
  _item_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.photo_capture_sessions;
  item record;
  queued integer := 0;
  queued_job_id uuid;
BEGIN
  SELECT * INTO target
  FROM public.photo_capture_sessions
  WHERE id = _session_id AND mode = 'bulk'
  FOR UPDATE;
  IF target.id IS NULL OR target.status <> 'prepared' OR target.vehicle_id IS NULL
     OR COALESCE(cardinality(_item_ids), 0) > 100
     OR NOT (
       private.current_user_has_store_capability(target.dealership_id, 'media')
       OR (target.created_by = actor_id
           AND private.current_user_has_store_capability(target.dealership_id, 'capture'))
     ) THEN
    RAISE EXCEPTION 'Background processing selection is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(cardinality(_item_ids), 0) <> COALESCE(
    (SELECT count(DISTINCT id) FROM unnest(_item_ids) AS id), 0
  ) THEN
    RAISE EXCEPTION 'Background processing selection contains duplicates.' USING ERRCODE = '22023';
  END IF;

  FOR item IN
    SELECT bulk.id, bulk.media_asset_id, bulk.photo_id
    FROM public.bulk_photo_items AS bulk
    WHERE bulk.session_id = target.id
      AND bulk.id = ANY(COALESCE(_item_ids, ARRAY[]::uuid[]))
      AND bulk.photo_id IS NOT NULL
      AND bulk.media_asset_id IS NOT NULL
  LOOP
    queued_job_id := private.ensure_background_removal_job(
      target.dealership_id, item.media_asset_id, item.photo_id, actor_id
    );
    IF queued_job_id IS NOT NULL THEN queued := queued + 1; END IF;
  END LOOP;

  IF queued > 0 THEN
    INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
    VALUES (
      'bulk_photo.background_processing_queued', actor_id, target.dealership_id,
      jsonb_build_object(
        'capture_session_id', target.id,
        'vehicle_id', target.vehicle_id,
        'selected_count', cardinality(_item_ids),
        'queued_count', queued
      )
    );
  END IF;
  RETURN queued;
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
          WHEN job.status = 'succeeded' THEN 'completed'
          WHEN job.status = 'dead_letter' THEN 'failed'
          ELSE job.status
        END AS status,
        job.status = 'dead_letter' AND job.attempt_count < 25 AS retryable,
        job.status IN ('queued', 'retry_scheduled', 'running', 'dead_letter')
          AND job.cancel_requested_at IS NULL AS cancelable,
        job.cancel_requested_at IS NOT NULL AS cancel_requested,
        CASE WHEN job.status = 'dead_letter'
          THEN 'Background removal failed. Your original photo is unchanged.'
          ELSE NULL END AS safe_failure_label,
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
          OR (job.status = 'dead_letter' AND job.completed_at >= now() - interval '7 days')
          OR (job.status = 'cancelled' AND job.completed_at >= now() - interval '1 hour')
        )
      ORDER BY job.created_at DESC
      LIMIT _limit
    ) AS activity
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.worker_get_background_removal_source(uuid)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_commit_background_cutout(
  uuid, uuid, text, text, bigint, integer, integer, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_complete_background_job(text, uuid, jsonb)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_fail_background_job(text, uuid, text, boolean)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.queue_vehicle_background_removal(uuid, uuid[])
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.queue_bulk_background_removal(uuid, uuid[])
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_background_removal_activity(uuid, integer)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.worker_get_background_removal_source(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_commit_background_cutout(
  uuid, uuid, text, text, bigint, integer, integer, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_complete_background_job(text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_fail_background_job(text, uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.queue_vehicle_background_removal(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.queue_bulk_background_removal(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_background_removal_activity(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.get_background_removal_activity(uuid, integer) IS
  'Returns safe retry/cancel eligibility and recent durable background-removal states for one authorized store.';
