-- Roll out the higher-quality vehicle-specific segmenter conservatively. V3
-- outputs are private draft cutouts and never replace the immutable original
-- until an authorized user approves/corrects them through Fix Cutout.

CREATE OR REPLACE FUNCTION public.worker_commit_vehicle_segmentation_v3_review(
  _job_id uuid,
  _variant_id uuid,
  _storage_bucket text,
  _storage_path text,
  _byte_size bigint,
  _width integer,
  _height integer,
  _checksum_sha256 text,
  _diagnostics jsonb,
  _metadata jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result_id uuid;
BEGIN
  IF jsonb_typeof(COALESCE(_diagnostics, '{}'::jsonb)) <> 'object'
     OR octet_length(COALESCE(_diagnostics, '{}'::jsonb)::text) > 16384
     OR jsonb_typeof(COALESCE(_metadata, '{}'::jsonb)) <> 'object'
     OR octet_length(COALESCE(_metadata, '{}'::jsonb)::text) > 65536 THEN
    RAISE EXCEPTION 'Invalid vehicle-segmentation metadata.' USING ERRCODE = '22023';
  END IF;

  result_id := public.worker_commit_background_cutout_result(
    _job_id,
    _variant_id,
    _storage_bucket,
    _storage_path,
    _byte_size,
    _width,
    _height,
    _checksum_sha256,
    'needs_review',
    COALESCE(_diagnostics, '{}'::jsonb)
  );

  UPDATE public.media_variants
  SET processing_provider = 'dealershot-vehicle-segmentation-v3',
      metadata = metadata || COALESCE(_metadata, '{}'::jsonb) || jsonb_build_object(
        'quality_class', 'needs_review',
        'auto_promoted', false,
        'rollout_policy', 'review_required'
      )
  WHERE id = result_id;

  UPDATE public.photos
  SET processing_provider = 'dealershot-vehicle-segmentation-v3',
      updated_at = now()
  WHERE cutout_image_url = 'private-media://' || result_id;

  RETURN result_id;
END;
$$;

REVOKE ALL ON FUNCTION public.worker_commit_vehicle_segmentation_v3_review(
  uuid, uuid, text, text, bigint, integer, integer, text, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_commit_vehicle_segmentation_v3_review(
  uuid, uuid, text, text, bigint, integer, integer, text, jsonb, jsonb
) TO service_role;

COMMENT ON FUNCTION public.worker_commit_vehicle_segmentation_v3_review(
  uuid, uuid, text, text, bigint, integer, integer, text, jsonb, jsonb
) IS 'Commits a private review-required V3 vehicle cutout without replacing the immutable original.';
