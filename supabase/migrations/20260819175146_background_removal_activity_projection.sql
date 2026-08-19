-- Tenant-authorized projection for the operational background-removal widget.
-- The durable job table remains private and is never granted to browser roles.

CREATE OR REPLACE FUNCTION public.get_background_removal_activity(
  _dealership_id uuid,
  _limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'media') THEN
    RAISE EXCEPTION 'Background processing activity is unavailable.' USING ERRCODE = '42501';
  END IF;

  IF _limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Invalid activity limit.' USING ERRCODE = '22023';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(activity) ORDER BY activity.created_at DESC)
    FROM (
      SELECT
        job.id AS job_id,
        job.resource_id AS media_asset_id,
        NULLIF(job.payload ->> 'photo_id', '')::uuid AS photo_id,
        asset.vehicle_id,
        vehicle.stock_number,
        concat_ws(
          ' ',
          vehicle.year::text,
          NULLIF(vehicle.make, ''),
          NULLIF(vehicle.model, '')
        ) AS vehicle_label,
        CASE job.status
          WHEN 'queued' THEN 'queued'
          WHEN 'retry_scheduled' THEN 'queued'
          WHEN 'running' THEN 'processing'
          WHEN 'succeeded' THEN 'completed'
          WHEN 'dead_letter' THEN 'failed'
          ELSE job.status
        END AS status,
        job.attempt_count,
        job.max_attempts,
        job.created_at,
        job.started_at,
        job.completed_at,
        job.updated_at
      FROM private.background_jobs AS job
      LEFT JOIN public.media_assets AS asset
        ON asset.id = job.resource_id
       AND job.resource_type = 'media_asset'
      LEFT JOIN public.vehicles AS vehicle
        ON vehicle.id = asset.vehicle_id
       AND vehicle.dealership_id = _dealership_id
      WHERE job.dealership_id = _dealership_id
        AND job.job_type = 'media.background.remove'
        AND (
          job.status IN ('queued', 'running', 'retry_scheduled')
          OR (job.status = 'succeeded' AND job.completed_at >= now() - interval '1 hour')
          OR (job.status = 'dead_letter' AND job.completed_at >= now() - interval '7 days')
        )
      ORDER BY job.created_at DESC
      LIMIT _limit
    ) AS activity
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.get_background_removal_activity(uuid, integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_background_removal_activity(uuid, integer)
TO authenticated;

COMMENT ON FUNCTION public.get_background_removal_activity(uuid, integer) IS
  'Returns recent background-removal job states for an authorized media user in one store.';
