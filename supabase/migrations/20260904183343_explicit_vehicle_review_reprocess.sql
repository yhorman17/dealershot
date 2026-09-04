-- Preserve passive completed-cutout deduplication while allowing an explicit
-- existing-vehicle Review action to create a new generation from the immutable
-- original. Historical variants/jobs remain append-only and one active job per
-- media asset continues to be enforced by the existing partial unique index.

CREATE OR REPLACE FUNCTION private.request_background_removal_job(
  _dealership_id uuid,
  _media_asset_id uuid,
  _photo_id uuid,
  _actor_id uuid,
  _request_source text,
  _explicit_reprocess boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  active_job private.background_jobs%ROWTYPE;
  previous_job private.background_jobs%ROWTYPE;
  new_job private.background_jobs%ROWTYPE;
  request_id uuid := gen_random_uuid();
  original_variant_id uuid;
  good_cutout_exists boolean;
  draft_cutout_exists boolean;
BEGIN
  IF _request_source NOT IN (
    'vehicle_review', 'vehicle_review_reprocess', 'bulk_review', 'manual_retry'
  ) THEN
    RAISE EXCEPTION 'Invalid background-removal request source.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.media_assets AS asset
  WHERE asset.id = _media_asset_id
    AND asset.dealership_id = _dealership_id
    AND asset.lifecycle_state = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.photos AS photo
      WHERE photo.id = _photo_id
        AND photo.media_asset_id = asset.id
        AND photo.vehicle_id = asset.vehicle_id
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Background-removal media is unavailable.' USING ERRCODE = '42501';
  END IF;

  SELECT variant.id INTO original_variant_id
  FROM public.media_variants AS variant
  WHERE variant.media_asset_id = _media_asset_id
    AND variant.variant_type = 'original'
    AND variant.archived_at IS NULL
  ORDER BY variant.created_at, variant.id
  LIMIT 1;
  IF original_variant_id IS NULL THEN
    RAISE EXCEPTION 'The immutable original is unavailable.' USING ERRCODE = '55000';
  END IF;

  -- Active work wins before completed/draft checks. Repeated taps on the
  -- explicit action therefore reuse the same generation instead of racing a
  -- second request into the queue.
  SELECT job.* INTO active_job
  FROM private.background_jobs AS job
  WHERE job.job_type = 'media.background.remove'
    AND job.resource_type = 'media_asset'
    AND job.resource_id = _media_asset_id
    AND job.status IN ('queued', 'retry_scheduled', 'running')
  ORDER BY job.created_at DESC, job.id DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'outcome', 'already_active',
      'job_id', active_job.id,
      'status', CASE WHEN active_job.status = 'running' THEN 'processing' ELSE 'queued' END
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.media_variants AS variant
    WHERE variant.media_asset_id = _media_asset_id
      AND variant.variant_type IN ('cutout', 'corrected_cutout')
      AND variant.processing_status = 'completed'
      AND variant.archived_at IS NULL
      AND COALESCE(variant.metadata ->> 'quality_class', 'good') <> 'needs_review'
  ) INTO good_cutout_exists;
  IF good_cutout_exists AND NOT _explicit_reprocess THEN
    RETURN jsonb_build_object('outcome', 'already_completed');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.media_variants AS variant
    WHERE variant.media_asset_id = _media_asset_id
      AND variant.variant_type IN ('cutout', 'corrected_cutout')
      AND variant.processing_status = 'completed'
      AND variant.archived_at IS NULL
      AND COALESCE(variant.metadata ->> 'quality_class', 'good') = 'needs_review'
  ) INTO draft_cutout_exists;
  IF draft_cutout_exists AND NOT _explicit_reprocess THEN
    RETURN jsonb_build_object('outcome', 'needs_review_existing');
  END IF;

  SELECT job.* INTO previous_job
  FROM private.background_jobs AS job
  WHERE job.job_type = 'media.background.remove'
    AND job.resource_type = 'media_asset'
    AND job.resource_id = _media_asset_id
  ORDER BY job.created_at DESC, job.id DESC
  LIMIT 1;

  INSERT INTO private.background_jobs (
    job_type, payload, dealership_id, resource_type, resource_id, dedupe_key,
    max_attempts, priority, created_by
  ) VALUES (
    'media.background.remove',
    jsonb_build_object(
      'media_asset_id', _media_asset_id,
      'photo_id', _photo_id,
      'source_variant_id', original_variant_id,
      'source_variant_type', 'original',
      'request_id', request_id,
      'request_source', _request_source,
      'request_mode', CASE WHEN _explicit_reprocess
        THEN 'explicit_reprocess_from_original' ELSE 'standard' END,
      'reprocesses_job_id', previous_job.id
    ),
    _dealership_id,
    'media_asset',
    _media_asset_id,
    'background-remove:' || _media_asset_id || ':v1:request:' || request_id,
    3,
    30,
    _actor_id
  )
  RETURNING * INTO new_job;

  RETURN jsonb_build_object(
    'outcome', 'queued',
    'job_id', new_job.id,
    'request_id', request_id,
    'source_variant_id', original_variant_id,
    'reprocess', _explicit_reprocess OR previous_job.id IS NOT NULL,
    'previous_job_id', previous_job.id
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT job.* INTO active_job
    FROM private.background_jobs AS job
    WHERE job.job_type = 'media.background.remove'
      AND job.resource_type = 'media_asset'
      AND job.resource_id = _media_asset_id
      AND job.status IN ('queued', 'retry_scheduled', 'running')
    ORDER BY job.created_at DESC, job.id DESC
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'outcome', 'already_active',
        'job_id', active_job.id,
        'status', CASE WHEN active_job.status = 'running' THEN 'processing' ELSE 'queued' END
      );
    END IF;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION private.request_background_removal_job(
  uuid, uuid, uuid, uuid, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.queue_vehicle_background_removal_request(
  _vehicle_id uuid,
  _media_asset_ids uuid[],
  _explicit_reprocess boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.vehicles;
  selected_media_id uuid;
  photo_id uuid;
  item_result jsonb;
  outcome text;
  selected_count integer := COALESCE(cardinality(_media_asset_ids), 0);
  queued_count integer := 0;
  reprocessed_count integer := 0;
  already_active_count integer := 0;
  already_completed_count integer := 0;
  needs_review_existing_count integer := 0;
  invalid_media_count integer := 0;
  failed_to_queue_count integer := 0;
  outcomes jsonb := '[]'::jsonb;
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

  FOREACH selected_media_id IN ARRAY COALESCE(_media_asset_ids, ARRAY[]::uuid[])
  LOOP
    photo_id := NULL;
    SELECT photo.id INTO photo_id
    FROM public.photos AS photo
    JOIN public.media_assets AS asset ON asset.id = photo.media_asset_id
    WHERE photo.vehicle_id = target.id
      AND photo.media_asset_id = selected_media_id
      AND asset.vehicle_id = target.id
      AND asset.dealership_id = target.dealership_id
      AND asset.lifecycle_state = 'active';

    IF photo_id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.media_assets AS asset
        WHERE asset.id = selected_media_id
          AND asset.dealership_id <> target.dealership_id
      ) THEN
        RAISE EXCEPTION 'Vehicle photo review is unavailable.' USING ERRCODE = '42501';
      END IF;
      invalid_media_count := invalid_media_count + 1;
      outcomes := outcomes || jsonb_build_array(jsonb_build_object(
        'media_asset_id', selected_media_id,
        'outcome', 'invalid_media'
      ));
      CONTINUE;
    END IF;

    BEGIN
      item_result := private.request_background_removal_job(
        target.dealership_id,
        selected_media_id,
        photo_id,
        actor_id,
        CASE WHEN _explicit_reprocess
          THEN 'vehicle_review_reprocess' ELSE 'vehicle_review' END,
        _explicit_reprocess
      );
      outcome := item_result ->> 'outcome';
    EXCEPTION WHEN OTHERS THEN
      item_result := jsonb_build_object('outcome', 'failed_to_queue');
      outcome := 'failed_to_queue';
    END;

    CASE outcome
      WHEN 'queued' THEN
        queued_count := queued_count + 1;
        IF _explicit_reprocess THEN reprocessed_count := reprocessed_count + 1; END IF;
      WHEN 'already_active' THEN already_active_count := already_active_count + 1;
      WHEN 'already_completed' THEN already_completed_count := already_completed_count + 1;
      WHEN 'needs_review_existing' THEN
        needs_review_existing_count := needs_review_existing_count + 1;
      WHEN 'invalid_media' THEN invalid_media_count := invalid_media_count + 1;
      ELSE failed_to_queue_count := failed_to_queue_count + 1;
    END CASE;

    outcomes := outcomes || jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'media_asset_id', selected_media_id,
        'photo_id', photo_id,
        'outcome', outcome,
        'job_id', item_result ->> 'job_id',
        'source_variant_id', item_result ->> 'source_variant_id',
        'reprocess', item_result -> 'reprocess'
      ))
    );
  END LOOP;

  IF selected_count > 0 THEN
    INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
    VALUES (
      CASE WHEN _explicit_reprocess
        THEN 'vehicle_photo.review_reprocess_requested'
        ELSE 'vehicle_photo.review_processing_selected' END,
      actor_id,
      target.dealership_id,
      jsonb_build_object(
        'vehicle_id', target.id,
        'request_mode', CASE WHEN _explicit_reprocess
          THEN 'explicit_reprocess_from_original' ELSE 'standard' END,
        'selected_count', selected_count,
        'queued_count', queued_count,
        'reprocessed_count', reprocessed_count,
        'already_active_count', already_active_count,
        'already_completed_count', already_completed_count,
        'needs_review_existing_count', needs_review_existing_count,
        'invalid_media_count', invalid_media_count,
        'failed_to_queue_count', failed_to_queue_count
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'selected_count', selected_count,
    'queued_count', queued_count,
    'reprocessed_count', reprocessed_count,
    'already_active_count', already_active_count,
    'already_completed_count', already_completed_count,
    'needs_review_existing_count', needs_review_existing_count,
    'invalid_media_count', invalid_media_count,
    'failed_to_queue_count', failed_to_queue_count,
    'skipped_count', selected_count - queued_count,
    'outcomes', outcomes
  );
END;
$$;

REVOKE ALL ON FUNCTION private.queue_vehicle_background_removal_request(uuid, uuid[], boolean)
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.queue_vehicle_background_removal(
  _vehicle_id uuid,
  _media_asset_ids uuid[]
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.queue_vehicle_background_removal_request(
    _vehicle_id, _media_asset_ids, false
  );
$$;

CREATE OR REPLACE FUNCTION public.reprocess_vehicle_background_removal(
  _vehicle_id uuid,
  _media_asset_ids uuid[]
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.queue_vehicle_background_removal_request(
    _vehicle_id, _media_asset_ids, true
  );
$$;

REVOKE ALL ON FUNCTION public.queue_vehicle_background_removal(uuid, uuid[])
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reprocess_vehicle_background_removal(uuid, uuid[])
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.queue_vehicle_background_removal(uuid, uuid[])
TO authenticated;
GRANT EXECUTE ON FUNCTION public.reprocess_vehicle_background_removal(uuid, uuid[])
TO authenticated;

COMMENT ON FUNCTION public.queue_vehicle_background_removal(uuid, uuid[]) IS
  'Queues passive existing-vehicle Review selections while retaining completed-cutout deduplication.';
COMMENT ON FUNCTION public.reprocess_vehicle_background_removal(uuid, uuid[]) IS
  'Queues explicit existing-vehicle Review reprocessing from the immutable original with append-only lineage.';
