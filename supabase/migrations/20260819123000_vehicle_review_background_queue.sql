-- Reuse the durable background-removal queue from an existing vehicle review.
-- This is deliberately separate from capture-session completion: office review
-- does not create a shoot, timer, payout, or photographer attribution.

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
  selected_count integer := coalesce(cardinality(_media_asset_ids), 0);
  queued_count integer := 0;
  skipped_count integer := 0;
BEGIN
  SELECT * INTO target
  FROM public.vehicles
  WHERE id = _vehicle_id;

  IF actor_id IS NULL
     OR target.id IS NULL
     OR NOT private.current_user_has_store_capability(target.dealership_id, 'media') THEN
    RAISE EXCEPTION 'Vehicle photo review is unavailable.' USING ERRCODE = '42501';
  END IF;

  IF selected_count > 100 THEN
    RAISE EXCEPTION 'Select no more than 100 photos.' USING ERRCODE = '22023';
  END IF;

  IF selected_count <> coalesce(
    (SELECT count(DISTINCT media_id) FROM unnest(_media_asset_ids) AS media_id),
    0
  ) THEN
    RAISE EXCEPTION 'Background processing selection contains duplicates.'
      USING ERRCODE = '22023';
  END IF;

  FOR photo IN
    SELECT p.id AS photo_id, p.media_asset_id
    FROM public.photos AS p
    JOIN public.media_assets AS asset ON asset.id = p.media_asset_id
    WHERE p.vehicle_id = target.id
      AND p.media_asset_id = ANY(coalesce(_media_asset_ids, ARRAY[]::uuid[]))
      AND asset.vehicle_id = target.id
      AND asset.lifecycle_state = 'active'
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.media_variants AS variant
      WHERE variant.media_asset_id = photo.media_asset_id
        AND variant.variant_type IN ('cutout', 'corrected_cutout')
        AND variant.processing_status = 'completed'
        AND variant.archived_at IS NULL
    ) THEN
      skipped_count := skipped_count + 1;
      CONTINUE;
    END IF;

    INSERT INTO private.background_jobs (
      job_type, payload, dealership_id, resource_type, resource_id, dedupe_key,
      max_attempts, priority, created_by
    ) VALUES (
      'media.background.remove',
      jsonb_build_object('media_asset_id', photo.media_asset_id, 'photo_id', photo.photo_id),
      target.dealership_id,
      'media_asset',
      photo.media_asset_id,
      'background-remove:' || photo.media_asset_id || ':v1',
      3,
      30,
      actor_id
    ) ON CONFLICT (job_type, dedupe_key) DO NOTHING;

    IF FOUND THEN
      queued_count := queued_count + 1;
      UPDATE public.photos
      SET processing_action = 'background_replace',
          processing_status = 'queued',
          processing_error = NULL,
          updated_at = now()
      WHERE id = photo.photo_id;
    ELSE
      skipped_count := skipped_count + 1;
    END IF;
  END LOOP;

  -- Invalid or cross-vehicle media IDs are never queued and are counted as
  -- skipped without revealing whether another store owns them.
  skipped_count := skipped_count + greatest(selected_count - queued_count - skipped_count, 0);

  IF selected_count > 0 THEN
    INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
    VALUES (
      'vehicle_photo.review_processing_selected',
      actor_id,
      target.dealership_id,
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

REVOKE ALL ON FUNCTION public.queue_vehicle_background_removal(uuid, uuid[])
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.queue_vehicle_background_removal(uuid, uuid[])
TO authenticated;

COMMENT ON FUNCTION public.queue_vehicle_background_removal(uuid, uuid[]) IS
  'Capability-authorized, idempotent background-removal selection for existing vehicle photo review.';
