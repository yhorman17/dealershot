-- Enqueue only after the application/worker release that understands these
-- job types is running. Keeping this separate from the ledger schema migration
-- prevents an older worker from dead-lettering migration work during cutover.
INSERT INTO private.background_jobs (
  job_type, payload, dealership_id, resource_type, resource_id, dedupe_key,
  max_attempts, priority
)
SELECT 'media.legacy.migrate', jsonb_build_object('migration_id', msm.id),
       ma.dealership_id, 'media_migration', msm.id, 'legacy:' || msm.id, 6, 30
FROM private.media_storage_migrations msm
JOIN public.media_assets ma ON ma.id = msm.media_asset_id
ON CONFLICT (job_type, dedupe_key) DO NOTHING;

INSERT INTO private.background_jobs (
  job_type, payload, resource_type, resource_id, dedupe_key, max_attempts, priority
)
SELECT
  'media.legacy.lockdown', '{}'::jsonb, 'media_migration', gen_random_uuid(),
  'legacy-bucket-lockdown-v1', 25, -50
WHERE EXISTS (SELECT 1 FROM private.media_storage_migrations)
ON CONFLICT (job_type, dedupe_key) DO NOTHING;
