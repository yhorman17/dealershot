-- Reporting users need a tenant-scoped projection of production records.
-- They intentionally do not receive direct access to protected membership,
-- profile, or capture-session tables.

CREATE OR REPLACE FUNCTION public.get_production_payout_report(
  _dealership_id uuid,
  _from_date date,
  _to_date date,
  _status text DEFAULT NULL
)
RETURNS TABLE (
  payout_id uuid,
  employee_id uuid,
  employee_name text,
  vehicle_id uuid,
  photo_shoot_id uuid,
  task_type text,
  work_date date,
  amount numeric,
  payout_status text,
  stock_number text,
  vin text,
  vehicle_name text,
  started_at timestamptz,
  completed_at timestamptz,
  duration_seconds integer,
  photo_count integer,
  video_count integer,
  review_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'reports') THEN
    RAISE EXCEPTION 'Production report is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF _from_date IS NULL OR _to_date IS NULL OR _from_date > _to_date
    OR _to_date - _from_date > 731
  THEN
    RAISE EXCEPTION 'Choose a valid report date range.' USING ERRCODE = '22023';
  END IF;
  IF _status IS NOT NULL AND _status NOT IN ('pending', 'approved', 'paid', 'void') THEN
    RAISE EXCEPTION 'Unsupported payout status.' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    payout.id,
    payout.employee_id,
    coalesce(profile.full_name, profile.email, 'Former user')::text,
    payout.vehicle_id,
    payout.photo_shoot_id,
    payout.task_type::text,
    payout.work_date,
    payout.amount,
    payout.status::text,
    coalesce(vehicle.stock_number, '')::text,
    coalesce(vehicle.vin, '')::text,
    concat_ws(' ', vehicle.year, vehicle.make, vehicle.model, vehicle.trim)::text,
    shoot.started_at,
    shoot.completed_at,
    shoot.duration_seconds,
    coalesce(shoot.photo_count, 0),
    coalesce(shoot.video_count, 0),
    coalesce(shoot.review_status, 'unreviewed')::text
  FROM public.payout_entries AS payout
  LEFT JOIN public.profiles AS profile ON profile.id = payout.employee_id
  LEFT JOIN public.vehicles AS vehicle ON vehicle.id = payout.vehicle_id
  LEFT JOIN public.photo_capture_sessions AS shoot ON shoot.id = payout.photo_shoot_id
  WHERE payout.dealership_id = _dealership_id
    AND payout.work_date BETWEEN _from_date AND _to_date
    AND (_status IS NULL OR payout.status::text = _status)
  ORDER BY payout.work_date DESC, payout.created_at DESC, payout.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_production_payout_report(uuid, date, date, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_production_payout_report(uuid, date, date, text)
  TO authenticated;
