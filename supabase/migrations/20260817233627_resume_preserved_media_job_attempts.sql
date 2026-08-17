-- The hosted SVG compatibility recovery intentionally preserved durable job
-- attempt history, but reset background_jobs.attempt_count to zero. The next
-- claim therefore reused attempt number 1 and collided with the attempt-history
-- primary key. Resume numbering after the latest preserved attempt instead of
-- deleting audit history.
WITH preserved_attempts AS (
  SELECT
    attempt.job_id,
    max(attempt.attempt_number)::integer AS latest_attempt
  FROM private.background_job_attempts AS attempt
  GROUP BY attempt.job_id
)
UPDATE private.background_jobs AS job
SET attempt_count = greatest(job.attempt_count, preserved.latest_attempt),
    max_attempts = greatest(job.max_attempts, preserved.latest_attempt + 4),
    status = 'queued',
    available_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = now()
FROM preserved_attempts AS preserved
WHERE job.id = preserved.job_id
  AND (
    (
      job.job_type = 'media.legacy.migrate'
      AND job.resource_id IN (
        SELECT migration.id
        FROM private.media_storage_migrations AS migration
        WHERE migration.destination_bucket = 'dealer-media-legacy-private'
          AND migration.state = 'legacy'
      )
    )
    OR job.job_type = 'media.legacy.lockdown'
  )
  AND job.status IN ('queued', 'retry_scheduled', 'failed', 'dead_letter');
