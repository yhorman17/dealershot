-- Hosted acceptance hardening.
--
-- Keep capture-session creation and operational-role discovery behind narrow,
-- authorization-checked RPCs. This avoids relying on PostgREST INSERT RETURNING
-- visibility and avoids granting ordinary users direct access to membership rows.

CREATE OR REPLACE FUNCTION public.start_photo_capture_session(
  _dealership_id uuid,
  _vehicle_id uuid DEFAULT NULL,
  _vin text DEFAULT NULL,
  _mode text DEFAULT 'guided'
)
RETURNS public.photo_capture_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.photo_capture_sessions;
  vehicle_store_id uuid;
  vehicle_vin text;
  normalized_vin text := upper(btrim(_vin));
BEGIN
  IF actor_id IS NULL
    OR _mode NOT IN ('guided', 'bulk')
    OR NOT private.current_user_has_active_membership(_dealership_id)
  THEN
    RAISE EXCEPTION 'Capture session is unavailable.' USING ERRCODE = '42501';
  END IF;

  IF _vehicle_id IS NOT NULL THEN
    SELECT vehicle.dealership_id, vehicle.vin
    INTO vehicle_store_id, vehicle_vin
    FROM public.vehicles AS vehicle
    WHERE vehicle.id = _vehicle_id;

    IF vehicle_store_id IS DISTINCT FROM _dealership_id THEN
      RAISE EXCEPTION 'Capture session is unavailable.' USING ERRCODE = '42501';
    END IF;

    normalized_vin := upper(btrim(vehicle_vin));
  ELSIF _mode = 'guided' THEN
    RAISE EXCEPTION 'Capture session is unavailable.' USING ERRCODE = '42501';
  END IF;

  IF _mode = 'bulk'
    AND (normalized_vin IS NULL OR normalized_vin !~ '^[A-HJ-NPR-Z0-9]{8,17}$')
  THEN
    RAISE EXCEPTION 'Enter a valid VIN before starting Bulk Photos.' USING ERRCODE = '22023';
  ELSIF _mode = 'guided'
    AND normalized_vin IS NOT NULL
    AND normalized_vin !~ '^[A-HJ-NPR-Z0-9]{8,17}$'
  THEN
    -- Imported legacy vehicle identifiers may predate VIN validation. Guided
    -- capture remains vehicle-bound, so omit an invalid denormalized VIN here.
    normalized_vin := NULL;
  END IF;

  INSERT INTO public.photo_capture_sessions (
    dealership_id,
    vehicle_id,
    vin,
    mode,
    status,
    created_by
  )
  VALUES (
    _dealership_id,
    _vehicle_id,
    nullif(normalized_vin, ''),
    _mode,
    'in_progress',
    actor_id
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO target;

  IF target.id IS NULL AND _mode = 'guided' THEN
    SELECT session.* INTO target
    FROM public.photo_capture_sessions AS session
    WHERE session.vehicle_id = _vehicle_id
      AND session.created_by = actor_id
      AND session.mode = 'guided'
      AND session.status = 'in_progress'
    LIMIT 1;
  END IF;

  IF target.id IS NULL THEN
    RAISE EXCEPTION 'Capture session could not be started.' USING ERRCODE = '23505';
  END IF;

  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_current_user_store_capabilities(
  _dealership_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'capture', private.current_user_has_store_capability(_dealership_id, 'capture'),
    'media', private.current_user_has_store_capability(_dealership_id, 'media'),
    'documents', private.current_user_has_store_capability(_dealership_id, 'documents'),
    'reports', private.current_user_has_store_capability(_dealership_id, 'reports'),
    'settings', private.current_user_has_store_capability(_dealership_id, 'settings'),
    'payout_status', private.current_user_has_store_capability(_dealership_id, 'payout_status')
  );
$$;

CREATE OR REPLACE FUNCTION public.list_payout_eligible_profiles(
  _dealership_id uuid
)
RETURNS TABLE(profile_id uuid, full_name text, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT profile.id, profile.full_name, profile.email
  FROM public.profile_dealerships AS membership
  JOIN public.profiles AS profile ON profile.id = membership.profile_id
  JOIN public.user_onboarding AS onboarding ON onboarding.profile_id = profile.id
  WHERE membership.dealership_id = _dealership_id
    AND membership.payout_eligible
    AND profile.status = 'active'
    AND onboarding.onboarding_state = 'complete'
    AND onboarding.password_change_required = false
    AND private.current_user_has_store_capability(_dealership_id, 'reports')
  ORDER BY profile.full_name NULLS LAST, profile.email;
$$;

REVOKE ALL ON FUNCTION public.start_photo_capture_session(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_current_user_store_capabilities(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_payout_eligible_profiles(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.start_photo_capture_session(uuid, uuid, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_current_user_store_capabilities(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_payout_eligible_profiles(uuid)
  TO authenticated;
