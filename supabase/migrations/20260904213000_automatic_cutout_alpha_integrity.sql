-- Prevent stale derivatives from outranking the approved media variant and
-- demote automatic cutouts produced before the one-channel alpha composition
-- contract was fixed. Originals and all historical derivatives remain intact.

CREATE OR REPLACE FUNCTION public.get_media_delivery_manifest(
  _media_asset_id uuid,
  _purpose text DEFAULT 'preview',
  _variant_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  asset public.media_assets%ROWTYPE;
  variant public.media_variants%ROWTYPE;
  photo public.photos%ROWTYPE;
BEGIN
  IF _purpose NOT IN ('thumbnail','preview','original','editor','download') THEN
    RAISE EXCEPTION 'Unsupported media purpose.' USING ERRCODE = '22023';
  END IF;
  IF NOT private.current_user_can_access_media_asset(_media_asset_id, _purpose) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO asset FROM public.media_assets WHERE id = _media_asset_id;
  SELECT * INTO photo FROM public.photos WHERE media_asset_id = asset.id LIMIT 1;

  IF _variant_id IS NOT NULL THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE id = _variant_id AND media_asset_id = asset.id AND archived_at IS NULL;
  ELSIF _purpose = 'original' THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE media_asset_id = asset.id AND variant_type = 'original' AND archived_at IS NULL
    ORDER BY created_at LIMIT 1;
  ELSIF _purpose IN ('thumbnail', 'preview') AND photo.approved_variant_id IS NOT NULL THEN
    -- A thumbnail/preview is valid only for the currently approved source.
    -- Older preview rows must never mask a newly-promoted reprocess result.
    SELECT * INTO variant FROM public.media_variants
    WHERE media_asset_id = asset.id
      AND source_variant_id = photo.approved_variant_id
      AND archived_at IS NULL
      AND (
        (_purpose = 'thumbnail' AND variant_type = 'thumbnail')
        OR (_purpose = 'preview' AND variant_type IN ('preview','thumbnail'))
      )
    ORDER BY
      CASE WHEN _purpose = 'preview' THEN (variant_type = 'preview')::integer ELSE 0 END DESC,
      CASE WHEN _purpose = 'thumbnail' THEN width END ASC NULLS LAST,
      CASE WHEN _purpose = 'preview' THEN width END DESC NULLS LAST,
      created_at DESC
    LIMIT 1;
  ELSIF _purpose = 'thumbnail' THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE media_asset_id = asset.id AND variant_type = 'thumbnail' AND archived_at IS NULL
    ORDER BY width ASC NULLS LAST, created_at DESC LIMIT 1;
  ELSIF _purpose = 'preview' THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE media_asset_id = asset.id AND variant_type IN ('preview','thumbnail') AND archived_at IS NULL
    ORDER BY (variant_type = 'preview') DESC, width DESC NULLS LAST, created_at DESC LIMIT 1;
  END IF;

  IF variant.id IS NULL AND photo.approved_variant_id IS NOT NULL THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE id = photo.approved_variant_id AND media_asset_id = asset.id AND archived_at IS NULL;
  END IF;
  IF variant.id IS NULL THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE media_asset_id = asset.id AND variant_type = 'original' AND archived_at IS NULL
    ORDER BY created_at LIMIT 1;
  END IF;
  IF variant.id IS NULL AND asset.storage_bucket IS NOT NULL AND asset.storage_object_path IS NOT NULL THEN
    RETURN jsonb_build_object(
      'media_asset_id', asset.id,
      'dealership_id', asset.dealership_id,
      'vehicle_id', asset.vehicle_id,
      'variant_id', NULL,
      'bucket', asset.storage_bucket,
      'path', asset.storage_object_path,
      'content_type', asset.content_type,
      'variant_type', 'original',
      'width', asset.width,
      'height', asset.height,
      'byte_size', asset.byte_size
    );
  ELSIF variant.id IS NULL OR variant.storage_bucket IS NULL OR variant.storage_path IS NULL THEN
    RAISE EXCEPTION 'Media derivative is not available.' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'media_asset_id', asset.id,
    'dealership_id', asset.dealership_id,
    'vehicle_id', asset.vehicle_id,
    'variant_id', variant.id,
    'bucket', variant.storage_bucket,
    'path', variant.storage_path,
    'content_type', variant.content_type,
    'variant_type', variant.variant_type,
    'width', variant.width,
    'height', variant.height,
    'byte_size', variant.byte_size
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_media_delivery_manifest(uuid, text, uuid)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_media_delivery_manifest(uuid, text, uuid)
TO authenticated;

-- Supabase/psql migration runners may autocommit each statement, so retain the
-- session-local table until this migration connection closes.
CREATE TEMP TABLE reconciled_automatic_cutouts AS
SELECT
  photo.id AS photo_id,
  asset.dealership_id,
  photo.vehicle_id,
  photo.approved_variant_id AS bad_variant_id,
  original.id AS original_variant_id,
  original.image_url AS original_image_url
FROM public.photos AS photo
JOIN public.media_assets AS asset ON asset.id = photo.media_asset_id
JOIN public.media_variants AS approved ON approved.id = photo.approved_variant_id
JOIN LATERAL (
  SELECT variant.id, variant.image_url
  FROM public.media_variants AS variant
  WHERE variant.media_asset_id = photo.media_asset_id
    AND variant.variant_type = 'original'
    AND variant.archived_at IS NULL
  ORDER BY variant.created_at
  LIMIT 1
) AS original ON true
WHERE approved.processing_provider = 'dealershot-isnet-node'
  AND approved.variant_type = 'cutout'
  AND approved.variant_role = 'prepared'
  AND approved.archived_at IS NULL;

UPDATE public.media_variants AS variant
SET variant_role = 'draft',
    metadata = COALESCE(variant.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'quality_class', 'needs_review',
        'auto_promoted', false,
        'reconciled_reason', 'legacy_output_alpha_channel_corruption',
        'reconciled_at', now()
      )
FROM reconciled_automatic_cutouts AS affected
WHERE variant.id = affected.bad_variant_id;

UPDATE public.photos AS photo
SET image_url = affected.original_image_url,
    approved_variant_id = affected.original_variant_id,
    -- The corrupt spatial alpha is not a useful Fix Cutout starting point. Keep
    -- its ledger row as draft evidence, but stop every normal photo/editor
    -- projection from treating it as the current cutout.
    cutout_image_url = NULL,
    corrected_cutout_url = NULL,
    is_cutout = false,
    cutout_status = 'needs_review',
    photo_state = 'raw',
    processing_action = 'manual_review',
    processing_status = 'completed',
    processing_provider = 'dealershot-isnet-node',
    processing_error = 'legacy_output_alpha_channel_corruption',
    review_status = 'awaiting_review',
    quality_issues = COALESCE(photo.quality_issues, '[]'::jsonb)
      || jsonb_build_array('legacy_output_alpha_channel_corruption'),
    updated_at = now()
FROM reconciled_automatic_cutouts AS affected
WHERE photo.id = affected.photo_id;

INSERT INTO public.audit_events (event_type, dealership_id, payload)
SELECT
  'vehicle_media.automatic_cutout_reconciled',
  affected.dealership_id,
  jsonb_build_object(
    'vehicle_id', affected.vehicle_id,
    'photo_id', affected.photo_id,
    'demoted_variant_id', affected.bad_variant_id,
    'restored_variant_id', affected.original_variant_id,
    'reason', 'legacy_output_alpha_channel_corruption'
  )
FROM reconciled_automatic_cutouts AS affected;

COMMENT ON FUNCTION public.get_media_delivery_manifest(uuid, text, uuid) IS
  'Capability-scoped private media delivery; preview derivatives must belong to the current approved variant.';
