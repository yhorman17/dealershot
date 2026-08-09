-- Hosted Auth lifecycle hardening discovered during the Phase 1 release gate.
--
-- A password update is an external GoTrue operation and cannot share a
-- transaction with PostgreSQL. Contain the target at the database boundary
-- before calling GoTrue so already-issued sessions lose business-data access
-- immediately, regardless of the provider response. Also serialize active
-- resets per target so two administrators cannot receive different temporary
-- passwords for the same account concurrently.

CREATE UNIQUE INDEX user_account_operations_active_reset_target_idx
  ON public.user_account_operations (target_profile_id)
  WHERE operation_type = 'temporary_password_reset'
    AND status IN ('requested', 'auth_pending', 'auth_updated');

CREATE OR REPLACE FUNCTION private.prevent_access_change_during_active_reset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_account_operations AS operation
    WHERE operation.operation_type = 'temporary_password_reset'
      AND operation.target_profile_id = OLD.id
      AND operation.status IN ('requested', 'auth_pending', 'auth_updated')
  ) THEN
    RAISE EXCEPTION 'Account access cannot change while a credential reset is in progress.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_block_access_change_during_active_reset
BEFORE UPDATE OF role, dealership_id ON public.profiles
FOR EACH ROW
WHEN (
  OLD.role IS DISTINCT FROM NEW.role
  OR OLD.dealership_id IS DISTINCT FROM NEW.dealership_id
)
EXECUTE FUNCTION private.prevent_access_change_during_active_reset();

REVOKE ALL ON FUNCTION private.prevent_access_change_during_active_reset()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.begin_temporary_password_reset_operation(
  _actor_id uuid,
  _idempotency_key uuid,
  _target_profile_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.profiles%ROWTYPE;
  existing public.user_account_operations%ROWTYPE;
  target_dealership_id uuid;
  operation_id uuid;
BEGIN
  IF _idempotency_key IS NULL THEN
    RAISE EXCEPTION 'An idempotency key is required.';
  END IF;
  IF _actor_id = _target_profile_id THEN
    RAISE EXCEPTION 'You cannot reset your own credentials here.';
  END IF;
  SELECT * INTO target FROM public.profiles WHERE id = _target_profile_id;
  IF NOT FOUND OR target.status <> 'active' OR target.role = 'owner'::public.app_role THEN
    RAISE EXCEPTION 'This account is not eligible for an administrator reset.';
  END IF;

  SELECT pd.dealership_id INTO target_dealership_id
  FROM public.profile_dealerships AS pd
  JOIN public.dealerships AS d ON d.id = pd.dealership_id
  WHERE pd.profile_id = target.id
    AND d.status IN ('active', 'trial')
    AND d.subscription_status = 'active'
  ORDER BY (pd.dealership_id = target.dealership_id) DESC
  LIMIT 1;
  IF target_dealership_id IS NULL THEN
    RAISE EXCEPTION 'The target account has no active dealership.';
  END IF;

  IF NOT (SELECT private.actor_is_active_owner(_actor_id)) THEN
    IF target.role <> 'staff'::public.app_role
       OR NOT (SELECT private.actor_is_active_dealer_admin_for(_actor_id, target_dealership_id)) THEN
      RAISE EXCEPTION 'Forbidden';
    END IF;
  END IF;

  SELECT * INTO existing
  FROM public.user_account_operations
  WHERE actor_profile_id = _actor_id AND idempotency_key = _idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF existing.operation_type <> 'temporary_password_reset'
       OR existing.target_profile_id <> _target_profile_id THEN
      RAISE EXCEPTION 'This idempotency key belongs to a different request.';
    END IF;

    -- Older in-flight operations may predate this hardening migration. Make
    -- their replay fail closed without issuing or redisplaying a credential.
    IF existing.status IN ('requested', 'auth_pending', 'auth_updated', 'needs_reconciliation') THEN
      UPDATE public.user_onboarding
      SET onboarding_method = 'admin_provisioned',
          onboarding_state = 'password_change_required',
          password_change_required = true,
          password_changed_at = NULL,
          completed_at = NULL,
          issued_by = _actor_id,
          updated_at = now()
      WHERE profile_id = target.id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Target onboarding state is missing.'; END IF;
    END IF;

    RETURN jsonb_build_object('operation_id', existing.id, 'status', existing.status);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_account_operations AS operation
    WHERE operation.operation_type = 'temporary_password_reset'
      AND operation.target_profile_id = _target_profile_id
      AND operation.status IN ('requested', 'auth_pending', 'auth_updated')
  ) THEN
    RAISE EXCEPTION 'A credential reset is already in progress for this account.';
  END IF;

  BEGIN
    INSERT INTO public.user_account_operations (
      actor_profile_id, operation_type, idempotency_key, target_profile_id,
      target_email, requested_role, primary_dealership_id
    ) VALUES (
      _actor_id, 'temporary_password_reset', _idempotency_key, target.id,
      lower(target.email), target.role, target_dealership_id
    ) RETURNING id INTO operation_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A credential reset is already in progress for this account.';
  END;

  -- This must commit before trusted server code calls GoTrue. Every RLS root
  -- helper checks this row, so an already-issued JWT is contained immediately.
  UPDATE public.user_onboarding
  SET onboarding_method = 'admin_provisioned',
      onboarding_state = 'password_change_required',
      password_change_required = true,
      credential_issued_at = NULL,
      password_changed_at = NULL,
      completed_at = NULL,
      issued_by = _actor_id,
      updated_at = now()
  WHERE profile_id = target.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target onboarding state is missing.'; END IF;

  INSERT INTO public.audit_events (
    event_type, actor_profile_id, target_profile_id, dealership_id, request_id, payload
  ) VALUES (
    'user.temporary_password_reset_started', _actor_id, target.id,
    target_dealership_id, _idempotency_key, jsonb_build_object('role', target.role)
  );

  RETURN jsonb_build_object('operation_id', operation_id, 'status', 'requested');
END;
$$;

-- Only an administrator-provisioned/reset account may complete this route.
-- Invitation onboarding remains exclusively controlled by accept_invitation.
CREATE OR REPLACE FUNCTION public.complete_temporary_password_onboarding(_actor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _actor_id IS NULL OR _actor_id <> (SELECT auth.uid()) THEN
    IF (SELECT auth.uid()) IS NOT NULL THEN
      RAISE EXCEPTION 'Forbidden';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = _actor_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Account unavailable.';
  END IF;

  UPDATE public.user_onboarding
  SET onboarding_state = 'complete',
      password_change_required = false,
      password_changed_at = now(),
      completed_at = now(),
      updated_at = now()
  WHERE profile_id = _actor_id
    AND onboarding_method = 'admin_provisioned'
    AND onboarding_state = 'password_change_required'
    AND password_change_required = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Password change is not required.';
  END IF;

  INSERT INTO public.audit_events (event_type, actor_profile_id, target_profile_id, payload)
  VALUES ('user.temporary_password_changed', _actor_id, _actor_id, '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.begin_temporary_password_reset_operation(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_temporary_password_reset_operation(uuid, uuid, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.complete_temporary_password_onboarding(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_temporary_password_onboarding(uuid)
  TO service_role;
