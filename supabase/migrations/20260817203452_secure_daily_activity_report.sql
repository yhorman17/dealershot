-- Reporting users need a tenant-scoped projection of completed capture sessions.
-- Direct capture-session access remains intentionally unavailable to accounting roles.

CREATE OR REPLACE FUNCTION public.get_daily_activity_report(
  _dealership_id uuid,
  _from_date date,
  _to_date date
)
RETURNS TABLE (
  id uuid,
  completed_at timestamptz,
  created_by uuid,
  photo_count integer,
  video_count integer,
  duration_seconds integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'reports') THEN
    RAISE EXCEPTION 'Daily activity report is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF _from_date IS NULL OR _to_date IS NULL OR _from_date > _to_date
    OR _to_date - _from_date > 731
  THEN
    RAISE EXCEPTION 'Choose a valid report date range.' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    shoot.id,
    shoot.completed_at,
    shoot.created_by,
    coalesce(shoot.photo_count, 0),
    coalesce(shoot.video_count, 0),
    shoot.duration_seconds
  FROM public.photo_capture_sessions AS shoot
  JOIN public.dealerships AS dealership ON dealership.id = shoot.dealership_id
  WHERE shoot.dealership_id = _dealership_id
    AND shoot.status = 'completed'
    AND (shoot.completed_at AT TIME ZONE coalesce(dealership.timezone, 'America/New_York'))::date
      BETWEEN _from_date AND _to_date
  ORDER BY shoot.completed_at DESC, shoot.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_daily_activity_report(uuid, date, date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_daily_activity_report(uuid, date, date)
  TO authenticated;
