-- Store-scoped, capability-authorized bulk controls for the durable
-- background-removal queue. Individual retry/cancel functions remain the
-- canonical per-job operations and retain their locking and audit behavior.

CREATE OR REPLACE FUNCTION public.retry_failed_background_removals(
  _dealership_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target private.background_jobs%ROWTYPE;
  item_result jsonb;
  failed_count integer := 0;
  retried_count integer := 0;
  not_retryable_count integer := 0;
  already_active_count integer := 0;
  already_completed_count integer := 0;
  retry_allowed boolean;
BEGIN
  IF actor_id IS NULL
     OR NOT private.current_user_has_store_capability(_dealership_id, 'media') THEN
    RAISE EXCEPTION 'Bulk background-removal retry is unavailable.' USING ERRCODE = '42501';
  END IF;

  FOR target IN
    SELECT job.*
    FROM private.background_jobs AS job
    JOIN public.media_assets AS asset
      ON asset.id = job.resource_id
     AND job.resource_type = 'media_asset'
     AND asset.dealership_id = _dealership_id
     AND asset.lifecycle_state = 'active'
    WHERE job.dealership_id = _dealership_id
      AND job.job_type = 'media.background.remove'
      AND job.status = 'dead_letter'
    ORDER BY job.created_at, job.id
    FOR UPDATE OF job
  LOOP
    failed_count := failed_count + 1;

    IF EXISTS (
      SELECT 1
      FROM private.background_jobs AS active_job
      WHERE active_job.id <> target.id
        AND active_job.job_type = 'media.background.remove'
        AND active_job.resource_type = 'media_asset'
        AND active_job.resource_id = target.resource_id
        AND active_job.status IN ('queued', 'retry_scheduled', 'running')
        AND active_job.cancel_requested_at IS NULL
    ) THEN
      already_active_count := already_active_count + 1;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.media_variants AS variant
      WHERE variant.media_asset_id = target.resource_id
        AND variant.variant_type IN ('cutout', 'corrected_cutout')
        AND variant.processing_status = 'completed'
        AND variant.archived_at IS NULL
        AND COALESCE(variant.metadata ->> 'quality_class', 'good') <> 'needs_review'
    ) THEN
      already_completed_count := already_completed_count + 1;
      CONTINUE;
    END IF;

    retry_allowed := CASE
      WHEN target.failure_category = 'source_invalid' THEN false
      WHEN target.failure_category IN ('model_rejection', 'resource_failure')
        THEN target.deterministic_failure_count < 2
      WHEN target.failure_category IN ('transient', 'finalization_failure')
        THEN target.attempt_count < 25
      WHEN target.failure_category IS NULL THEN target.attempt_count < 2
      ELSE false
    END;

    IF NOT retry_allowed THEN
      not_retryable_count := not_retryable_count + 1;
      CONTINUE;
    END IF;

    item_result := public.retry_background_removal(target.id);
    IF item_result ->> 'status' = 'queued' THEN
      retried_count := retried_count + 1;
    ELSIF item_result ->> 'status' IN ('processing', 'running') THEN
      already_active_count := already_active_count + 1;
    ELSIF item_result ->> 'status' IN ('completed', 'succeeded') THEN
      already_completed_count := already_completed_count + 1;
    ELSE
      not_retryable_count := not_retryable_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'failed_count', failed_count,
    'retried_count', retried_count,
    'not_retryable_count', not_retryable_count,
    'already_active_count', already_active_count,
    'already_completed_count', already_completed_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_background_removals(
  _dealership_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target private.background_jobs%ROWTYPE;
  item_result jsonb;
  selected_count integer := 0;
  canceled_count integer := 0;
  cancel_requested_count integer := 0;
  already_canceled_count integer := 0;
BEGIN
  IF actor_id IS NULL
     OR NOT private.current_user_has_store_capability(_dealership_id, 'media') THEN
    RAISE EXCEPTION 'Bulk background-removal cancellation is unavailable.' USING ERRCODE = '42501';
  END IF;

  FOR target IN
    SELECT job.*
    FROM private.background_jobs AS job
    JOIN public.media_assets AS asset
      ON asset.id = job.resource_id
     AND job.resource_type = 'media_asset'
     AND asset.dealership_id = _dealership_id
     AND asset.lifecycle_state = 'active'
    WHERE job.dealership_id = _dealership_id
      AND job.job_type = 'media.background.remove'
      AND job.status IN ('queued', 'retry_scheduled', 'running', 'dead_letter')
      AND job.cancel_requested_at IS NULL
    ORDER BY job.created_at, job.id
    FOR UPDATE OF job
  LOOP
    selected_count := selected_count + 1;
    item_result := public.cancel_background_removal(target.id);
    IF item_result ->> 'status' IN ('canceled', 'cancelled') THEN
      canceled_count := canceled_count + 1;
    ELSIF item_result ->> 'status' = 'cancel_requested' THEN
      cancel_requested_count := cancel_requested_count + 1;
    ELSE
      already_canceled_count := already_canceled_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'selected_count', selected_count,
    'canceled_count', canceled_count,
    'cancel_requested_count', cancel_requested_count,
    'already_canceled_count', already_canceled_count,
    'completed_untouched_count', (
      SELECT count(*)
      FROM private.background_jobs AS completed_job
      WHERE completed_job.dealership_id = _dealership_id
        AND completed_job.job_type = 'media.background.remove'
        AND completed_job.status = 'succeeded'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.retry_failed_background_removals(uuid)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_background_removals(uuid)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.retry_failed_background_removals(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_background_removals(uuid) TO authenticated;

COMMENT ON FUNCTION public.retry_failed_background_removals(uuid) IS
  'Capability-authorized, store-scoped and idempotent retry for eligible failed background-removal jobs.';
COMMENT ON FUNCTION public.cancel_background_removals(uuid) IS
  'Capability-authorized, store-scoped cancellation of queued, running and failed background-removal work; originals and completed variants remain intact.';
