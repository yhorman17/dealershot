-- Opt-in vehicle-aware cutout experiment. The existing background-removal
-- commit function remains unchanged as the production fallback.

CREATE OR REPLACE FUNCTION public.worker_commit_vehicle_aware_cutout(
  _job_id uuid,
  _variant_id uuid,
  _storage_bucket text,
  _storage_path text,
  _byte_size bigint,
  _width integer,
  _height integer,
  _checksum_sha256 text,
  _quality_class text,
  _quality_score numeric,
  _metadata jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source jsonb;
  result_id uuid;
  variant_status text;
BEGIN
  source := public.worker_get_background_removal_source(_job_id);
  IF source IS NULL OR _storage_bucket <> 'dealer-media-private'
     OR _storage_path NOT LIKE 'stores/' || (source->>'dealership_id') || '/vehicles/' ||
       (source->>'vehicle_id') || '/media/' || (source->>'media_asset_id') || '/variants/cutout/%'
     OR _byte_size NOT BETWEEN 1 AND 26214400 OR _width < 1 OR _height < 1
     OR _checksum_sha256 !~ '^[0-9a-f]{64}$'
     OR _quality_class NOT IN ('good', 'questionable', 'bad')
     OR _quality_score NOT BETWEEN 0 AND 1
     OR jsonb_typeof(_metadata) <> 'object'
     OR _metadata->>'pipeline_version' IS NULL
     OR _metadata->>'method' NOT IN ('vehicle_aware', 'standard_fallback') THEN
    RAISE EXCEPTION 'Invalid vehicle-aware background-removal output.' USING ERRCODE = '22023';
  END IF;

  variant_status := CASE WHEN _quality_class = 'bad' THEN 'failed' ELSE 'completed' END;
  INSERT INTO public.media_variants (
    id, photo_id, media_asset_id, variant_type, source_variant_id, image_url,
    storage_bucket, storage_path, content_type, processing_provider, processing_status,
    width, height, byte_size, checksum, variant_role, created_by, metadata
  ) VALUES (
    _variant_id, (source->>'photo_id')::uuid, (source->>'media_asset_id')::uuid, 'cutout',
    (source->>'source_variant_id')::uuid, 'private-media://' || _variant_id,
    _storage_bucket, _storage_path, 'image/png', 'dealershot-yolox-isnet-node', variant_status,
    _width, _height, _byte_size, _checksum_sha256, 'prepared', (source->>'actor_id')::uuid,
    _metadata || jsonb_build_object(
      'operation', 'vehicle_aware_background_remove',
      'job_id', _job_id,
      'quality_class', _quality_class,
      'quality_score', _quality_score
    )
  ) ON CONFLICT (storage_bucket, storage_path)
    WHERE storage_bucket IS NOT NULL AND storage_path IS NOT NULL
    DO UPDATE SET
      processing_status = EXCLUDED.processing_status,
      byte_size = EXCLUDED.byte_size,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      checksum = EXCLUDED.checksum,
      metadata = EXCLUDED.metadata
    RETURNING id INTO result_id;

  IF _quality_class = 'good' THEN
    UPDATE public.photos SET
      image_url = 'private-media://' || result_id,
      approved_variant_id = result_id,
      cutout_image_url = 'private-media://' || result_id,
      is_cutout = true,
      cutout_status = 'done',
      photo_state = 'cutout',
      processing_action = 'background_replace',
      processing_status = 'completed',
      processing_provider = 'dealershot-yolox-isnet-node',
      processing_error = NULL,
      review_status = 'awaiting_review',
      updated_at = now()
    WHERE id = (source->>'photo_id')::uuid;
  ELSIF _quality_class = 'questionable' THEN
    UPDATE public.photos SET
      cutout_image_url = 'private-media://' || result_id,
      is_cutout = true,
      cutout_status = 'needs_review',
      processing_action = 'background_replace',
      processing_status = 'completed',
      processing_provider = 'dealershot-yolox-isnet-node',
      processing_error = NULL,
      review_status = 'awaiting_review',
      updated_at = now()
    WHERE id = (source->>'photo_id')::uuid;
  ELSE
    UPDATE public.photos SET
      cutout_image_url = 'private-media://' || result_id,
      is_cutout = false,
      cutout_status = 'failed',
      processing_action = 'background_replace',
      processing_status = 'failed',
      processing_provider = 'dealershot-yolox-isnet-node',
      processing_error = 'mask_quality_bad',
      review_status = 'awaiting_review',
      updated_at = now()
    WHERE id = (source->>'photo_id')::uuid;
  END IF;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES (
    'vehicle_media.variant_created',
    (source->>'actor_id')::uuid,
    (source->>'dealership_id')::uuid,
    jsonb_build_object(
      'vehicle_id', (source->>'vehicle_id')::uuid,
      'photo_id', (source->>'photo_id')::uuid,
      'media_asset_id', (source->>'media_asset_id')::uuid,
      'variant_id', result_id,
      'variant_type', 'cutout',
      'job_id', _job_id,
      'processing_method', _metadata->>'method',
      'quality_class', _quality_class,
      'quality_score', _quality_score,
      'auto_promoted', _quality_class = 'good'
    )
  );
  RETURN result_id;
END;
$$;

REVOKE ALL ON FUNCTION public.worker_commit_vehicle_aware_cutout(
  uuid, uuid, text, text, bigint, integer, integer, text, text, numeric, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_commit_vehicle_aware_cutout(
  uuid, uuid, text, text, bigint, integer, integer, text, text, numeric, jsonb
) TO service_role;
