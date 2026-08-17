-- Some hosted legacy variants predate storage_path and retain only their
-- public compatibility URL. Normalize those references before enqueueing the
-- resumable private-media copy jobs. The original objects remain untouched
-- until the worker has copied and byte-verified every destination.
UPDATE public.media_variants AS mv
SET storage_bucket = 'vehicle-photos',
    storage_path = NULLIF(
      split_part(split_part(mv.image_url, '/vehicle-photos/', 2), '?', 1),
      ''
    )
WHERE mv.storage_path IS NULL
  AND mv.media_asset_id IS NOT NULL
  AND mv.image_url LIKE '%/vehicle-photos/%';

INSERT INTO private.media_storage_migrations (
  media_variant_id,
  media_asset_id,
  source_bucket,
  source_path,
  destination_path
)
SELECT
  mv.id,
  mv.media_asset_id,
  mv.storage_bucket,
  mv.storage_path,
  'stores/' || ma.dealership_id || '/vehicles/' || ma.vehicle_id ||
    '/media/' || ma.id || '/' || mv.variant_type || '/' ||
    regexp_replace(mv.storage_path, '^.*/', '')
FROM public.media_variants AS mv
JOIN public.media_assets AS ma ON ma.id = mv.media_asset_id
WHERE mv.storage_bucket = 'vehicle-photos'
  AND mv.storage_path IS NOT NULL
  AND mv.storage_path NOT LIKE 'unresolved/%'
ON CONFLICT (source_bucket, source_path) DO NOTHING;

UPDATE private.media_orphan_audit AS orphan
SET resolution = 'linked'
WHERE orphan.bucket_id = 'vehicle-photos'
  AND orphan.resolution = 'unresolved'
  AND EXISTS (
    SELECT 1
    FROM private.media_storage_migrations AS migration
    WHERE migration.source_bucket = orphan.bucket_id
      AND migration.source_path = orphan.object_path
  );

INSERT INTO private.background_jobs (
  job_type,
  payload,
  dealership_id,
  resource_type,
  resource_id,
  dedupe_key,
  max_attempts,
  priority
)
SELECT
  'media.legacy.migrate',
  jsonb_build_object('migration_id', migration.id),
  asset.dealership_id,
  'media_migration',
  migration.id,
  'legacy:' || migration.id,
  6,
  30
FROM private.media_storage_migrations AS migration
JOIN public.media_assets AS asset ON asset.id = migration.media_asset_id
ON CONFLICT (job_type, dedupe_key) DO NOTHING;

INSERT INTO private.background_jobs (
  job_type,
  payload,
  resource_type,
  resource_id,
  dedupe_key,
  max_attempts,
  priority
)
SELECT
  'media.legacy.lockdown',
  '{}'::jsonb,
  'media_migration',
  gen_random_uuid(),
  'legacy-bucket-lockdown-v1',
  25,
  -50
WHERE EXISTS (SELECT 1 FROM private.media_storage_migrations)
ON CONFLICT (job_type, dedupe_key) DO NOTHING;
