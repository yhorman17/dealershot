-- Historical staging fixtures include SVG vehicle-photo placeholders. New
-- uploads remain restricted to JPEG/PNG/WebP, but the exact legacy bytes must
-- be preserved privately without serving script-capable content inline. Store
-- those bytes as application/octet-stream in an isolated private bucket and
-- generate raster WebP display derivatives through the worker.
UPDATE private.media_storage_migrations
SET destination_bucket = 'dealer-media-legacy-private',
    state = 'legacy',
    attempt_count = 0,
    safe_error_code = NULL,
    updated_at = now()
WHERE source_bucket = 'vehicle-photos'
  AND source_path ~* '\.svg$'
  AND state IN ('legacy', 'failed');

CREATE OR REPLACE FUNCTION public.worker_complete_legacy_svg_migration(
  _migration_id uuid,
  _checksum_sha256 text,
  _byte_size bigint,
  _content_type text,
  _width integer,
  _height integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  migration private.media_storage_migrations%ROWTYPE;
  variant public.media_variants%ROWTYPE;
  asset public.media_assets%ROWTYPE;
BEGIN
  SELECT * INTO migration
  FROM private.media_storage_migrations
  WHERE id = _migration_id
  FOR UPDATE;

  IF migration.id IS NULL THEN RETURN false; END IF;

  SELECT * INTO variant FROM public.media_variants WHERE id = migration.media_variant_id;
  SELECT * INTO asset FROM public.media_assets WHERE id = migration.media_asset_id;

  IF migration.source_bucket <> 'vehicle-photos'
    OR migration.source_path !~* '\.svg$'
    OR migration.destination_bucket <> 'dealer-media-legacy-private'
    OR _checksum_sha256 !~ '^[0-9a-f]{64}$'
    OR _byte_size < 1
    OR _content_type <> 'image/svg+xml'
    OR _width IS NULL
    OR _height IS NULL
  THEN
    RAISE EXCEPTION 'Invalid legacy SVG migration verification.' USING ERRCODE = '22023';
  END IF;

  UPDATE private.media_storage_migrations
  SET state = 'private',
      source_byte_size = _byte_size,
      destination_byte_size = _byte_size,
      source_checksum_sha256 = _checksum_sha256,
      destination_checksum_sha256 = _checksum_sha256,
      verified_at = now(),
      safe_error_code = NULL,
      updated_at = now()
  WHERE id = migration.id;

  UPDATE public.media_variants
  SET storage_bucket = migration.destination_bucket,
      storage_path = migration.destination_path,
      image_url = 'private-media://' || id,
      content_type = _content_type,
      byte_size = _byte_size,
      width = _width,
      height = _height,
      checksum = _checksum_sha256,
      original_filename = COALESCE(
        original_filename,
        regexp_replace(migration.source_path, '^.*/', '')
      ),
      variant_role = COALESCE(
        variant_role,
        CASE WHEN variant_type = 'original' THEN 'source' ELSE 'prepared' END
      )
  WHERE id = variant.id;

  IF variant.variant_type = 'original' THEN
    UPDATE public.media_assets
    SET storage_bucket = migration.destination_bucket,
        storage_object_path = migration.destination_path,
        content_type = _content_type,
        byte_size = _byte_size,
        width = _width,
        height = _height,
        checksum_sha256 = _checksum_sha256,
        migration_state = 'private',
        updated_at = now()
    WHERE id = asset.id;

    UPDATE public.photos AS photo
    SET original_image_url = 'private-media://' || variant.id,
        image_url = CASE
          WHEN photo.approved_variant_id = variant.id
            THEN 'private-media://' || variant.id
          ELSE photo.image_url
        END,
        updated_at = now()
    WHERE photo.media_asset_id = asset.id;

    INSERT INTO private.background_jobs (
      job_type,
      payload,
      dealership_id,
      resource_type,
      resource_id,
      dedupe_key,
      max_attempts,
      priority,
      created_by
    )
    VALUES (
      'media.thumbnail.generate',
      jsonb_build_object('media_asset_id', asset.id),
      asset.dealership_id,
      'media_asset',
      asset.id,
      'thumbnail:' || asset.id,
      4,
      20,
      asset.uploaded_by
    )
    ON CONFLICT (job_type, dedupe_key) DO NOTHING;
  ELSE
    UPDATE public.photos AS photo
    SET image_url = CASE
          WHEN photo.approved_variant_id = variant.id
            THEN 'private-media://' || variant.id
          ELSE photo.image_url
        END,
        cutout_image_url = CASE
          WHEN photo.cutout_image_url = variant.image_url
            THEN 'private-media://' || variant.id
          ELSE photo.cutout_image_url
        END,
        corrected_cutout_url = CASE
          WHEN photo.corrected_cutout_url = variant.image_url
            THEN 'private-media://' || variant.id
          ELSE photo.corrected_cutout_url
        END,
        updated_at = now()
    WHERE photo.media_asset_id = asset.id;
  END IF;

  INSERT INTO public.audit_events (event_type, dealership_id, payload)
  VALUES (
    'vehicle_media.migration_completed',
    asset.dealership_id,
    jsonb_build_object(
      'media_asset_id', asset.id,
      'media_variant_id', variant.id,
      'legacy_svg_quarantined', true
    )
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.worker_complete_legacy_svg_migration(
  uuid, text, bigint, text, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_complete_legacy_svg_migration(
  uuid, text, bigint, text, integer, integer
) TO service_role;

UPDATE private.background_jobs AS job
SET status = 'queued',
    available_at = now(),
    attempt_count = 0,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = now()
WHERE job.job_type = 'media.legacy.migrate'
  AND job.resource_id IN (
    SELECT migration.id
    FROM private.media_storage_migrations AS migration
    WHERE migration.destination_bucket = 'dealer-media-legacy-private'
      AND migration.state = 'legacy'
  );

UPDATE private.background_jobs
SET status = 'queued',
    available_at = now(),
    attempt_count = 0,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = now()
WHERE job_type = 'media.legacy.lockdown'
  AND status IN ('retry_scheduled', 'failed', 'dead_letter');
