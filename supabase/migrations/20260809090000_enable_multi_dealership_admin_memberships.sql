-- Allow dealer administrators to operate across an explicit set of dealerships
-- while retaining profiles.dealership_id as the primary/default dealership.
-- Assignment writes remain server-only and are applied atomically by a
-- service-role-only function.

CREATE TABLE public.profile_dealerships (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, dealership_id)
);

CREATE INDEX profile_dealerships_dealership_id_idx
  ON public.profile_dealerships (dealership_id);

ALTER TABLE public.profile_dealerships ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.profile_dealerships FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.profile_dealerships TO service_role;

-- Seed each current dealer user with their existing primary dealership before
-- tenant helpers begin consulting the normalized assignment table.
INSERT INTO public.profile_dealerships (profile_id, dealership_id)
SELECT p.id, p.dealership_id
FROM public.profiles AS p
WHERE p.role <> 'owner'::public.app_role
  AND p.dealership_id IS NOT NULL;

CREATE OR REPLACE FUNCTION private.sync_primary_profile_dealership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.role = 'owner'::public.app_role THEN
    DELETE FROM public.profile_dealerships
    WHERE profile_id = NEW.id;
    RETURN NEW;
  END IF;

  IF NEW.dealership_id IS NULL THEN
    -- ON DELETE SET NULL may clear an administrator's primary dealership. Keep
    -- their other normalized assignments intact; the application will select
    -- the first remaining active dealership until an owner chooses a new
    -- primary. Staff accounts have no valid fallback and remain unassigned.
    IF NEW.role = 'staff'::public.app_role THEN
      DELETE FROM public.profile_dealerships
      WHERE profile_id = NEW.id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role = 'staff'::public.app_role THEN
    DELETE FROM public.profile_dealerships
    WHERE profile_id = NEW.id
      AND dealership_id <> NEW.dealership_id;
  END IF;

  INSERT INTO public.profile_dealerships (profile_id, dealership_id)
  VALUES (NEW.id, NEW.dealership_id)
  ON CONFLICT (profile_id, dealership_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.sync_primary_profile_dealership()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER sync_primary_profile_dealership
AFTER INSERT OR UPDATE OF role, dealership_id ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION private.sync_primary_profile_dealership();

CREATE OR REPLACE FUNCTION private.current_user_has_active_membership(_dealership_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT private.current_user_is_active_owner())
    OR EXISTS (
      SELECT 1
      FROM public.profiles AS p
      JOIN public.profile_dealerships AS pd ON pd.profile_id = p.id
      JOIN public.dealerships AS d ON d.id = pd.dealership_id
      WHERE p.id = (SELECT auth.uid())
        AND p.status = 'active'
        AND p.role <> 'owner'::public.app_role
        AND pd.dealership_id = _dealership_id
        AND (
          p.role = 'dealer_admin'::public.app_role
          OR p.dealership_id = pd.dealership_id
        )
        AND d.status IN ('active', 'trial')
        AND d.subscription_status = 'active'
    );
$$;

CREATE OR REPLACE FUNCTION private.current_user_is_dealership_admin(_dealership_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT private.current_user_is_active_owner())
    OR EXISTS (
      SELECT 1
      FROM public.profiles AS p
      JOIN public.profile_dealerships AS pd ON pd.profile_id = p.id
      JOIN public.dealerships AS d ON d.id = pd.dealership_id
      WHERE p.id = (SELECT auth.uid())
        AND p.status = 'active'
        AND p.role = 'dealer_admin'::public.app_role
        AND pd.dealership_id = _dealership_id
        AND d.status IN ('active', 'trial')
        AND d.subscription_status = 'active'
    );
$$;

DROP POLICY "Active users view permitted dealerships" ON public.dealerships;
CREATE POLICY "Active users view permitted dealerships"
ON public.dealerships FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(id));

CREATE OR REPLACE FUNCTION public.admin_update_user_account_access(
  _actor_user_id uuid,
  _target_user_id uuid,
  _full_name text,
  _role public.app_role,
  _dealership_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_role public.app_role;
  assignment_count integer;
  valid_dealership_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS actor
    WHERE actor.id = _actor_user_id
      AND actor.role = 'owner'::public.app_role
      AND actor.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF _actor_user_id = _target_user_id THEN
    RAISE EXCEPTION 'Use profile settings to change your own name.';
  END IF;

  SELECT p.role
  INTO target_role
  FROM public.profiles AS p
  WHERE p.id = _target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF target_role = 'owner'::public.app_role THEN
    RAISE EXCEPTION 'Owner roles cannot be changed through browser input.';
  END IF;
  IF _role NOT IN ('dealer_admin'::public.app_role, 'staff'::public.app_role) THEN
    RAISE EXCEPTION 'Select a dealer role for this user.';
  END IF;
  IF NULLIF(btrim(_full_name), '') IS NULL OR length(btrim(_full_name)) > 120 THEN
    RAISE EXCEPTION 'Enter a valid full name.';
  END IF;

  assignment_count := COALESCE(cardinality(_dealership_ids), 0);
  IF assignment_count = 0 OR array_position(_dealership_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Dealer users must belong to an active dealership.';
  END IF;
  IF assignment_count > 100 THEN
    RAISE EXCEPTION 'Too many dealership assignments.';
  END IF;
  IF _role = 'staff'::public.app_role AND assignment_count <> 1 THEN
    RAISE EXCEPTION 'Staff users must belong to exactly one dealership.';
  END IF;
  IF (
    SELECT count(DISTINCT dealership_id)
    FROM unnest(_dealership_ids) AS dealership_id
  ) <> assignment_count THEN
    RAISE EXCEPTION 'Duplicate dealership assignments are not allowed.';
  END IF;

  SELECT count(*)
  INTO valid_dealership_count
  FROM public.dealerships AS d
  WHERE d.id = ANY (_dealership_ids)
    AND d.status IN ('active', 'trial')
    AND d.subscription_status = 'active';

  IF valid_dealership_count <> assignment_count THEN
    RAISE EXCEPTION 'Every assigned dealership must be active.';
  END IF;

  UPDATE public.profiles
  SET full_name = btrim(_full_name),
      role = _role,
      dealership_id = _dealership_ids[1]
  WHERE id = _target_user_id;

  DELETE FROM public.profile_dealerships
  WHERE profile_id = _target_user_id;

  INSERT INTO public.profile_dealerships (profile_id, dealership_id)
  SELECT _target_user_id, assignment.dealership_id
  FROM unnest(_dealership_ids) WITH ORDINALITY AS assignment(dealership_id, position)
  ORDER BY assignment.position;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_user_account_access(
  uuid, uuid, text, public.app_role, uuid[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_user_account_access(
  uuid, uuid, text, public.app_role, uuid[]
) TO service_role;
