\set ON_ERROR_STOP on

CREATE SCHEMA test;

CREATE OR REPLACE FUNCTION test.assert_true(_condition boolean, _message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(_condition, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'ASSERTION FAILED: %', _message;
  END IF;
  RAISE NOTICE 'ok - %', _message;
END;
$$;

CREATE OR REPLACE FUNCTION test.assert_row_count(_sql text, _expected bigint, _message text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  actual bigint;
BEGIN
  EXECUTE _sql;
  GET DIAGNOSTICS actual = ROW_COUNT;
  IF actual <> _expected THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % (expected %, got %)', _message, _expected, actual;
  END IF;
  RAISE NOTICE 'ok - %', _message;
END;
$$;

CREATE OR REPLACE FUNCTION test.expect_sqlstate(
  _sql text,
  _expected_state text,
  _message text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  actual_state text;
BEGIN
  BEGIN
    EXECUTE _sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
    IF actual_state = _expected_state THEN
      RAISE NOTICE 'ok - %', _message;
      RETURN;
    END IF;
    RAISE EXCEPTION 'ASSERTION FAILED: % (expected SQLSTATE %, got %)',
      _message, _expected_state, actual_state;
  END;
  RAISE EXCEPTION 'ASSERTION FAILED: % (statement unexpectedly succeeded)', _message;
END;
$$;

GRANT USAGE ON SCHEMA test TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO anon, authenticated, service_role;

INSERT INTO public.organizations (id, name, status) VALUES
  ('11111111-aaaa-4000-8000-000000000001', 'Organization A', 'active'),
  ('22222222-bbbb-4000-8000-000000000001', 'Organization B', 'active'),
  ('33333333-cccc-4000-8000-000000000001', 'Suspended Organization', 'active'),
  ('44444444-dddd-4000-8000-000000000001', 'Inactive Subscription Organization', 'active');

INSERT INTO public.dealerships (id, organization_id, name, status, subscription_status) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-aaaa-4000-8000-000000000001', 'Dealer A', 'active', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-bbbb-4000-8000-000000000001', 'Dealer B', 'active', 'active'),
  ('cccccccc-0000-0000-0000-000000000001', '33333333-cccc-4000-8000-000000000001', 'Suspended Dealer', 'suspended', 'active'),
  ('dddddddd-0000-0000-0000-000000000001', '44444444-dddd-4000-8000-000000000001', 'Inactive Subscription', 'active', 'past_due');

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'owner@example.test', '{}', now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000002', 'admin-a@example.test', '{}', now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000003', 'staff-a@example.test', '{}', now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000004', 'staff-b@example.test', '{}', now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000005', 'deactivated@example.test', '{}', now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000006', 'suspended@example.test', '{}', now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000007', 'invitee@example.test', '{}', now()),
  ('00000000-0000-0000-0000-000000000008', 'blocked-owner@example.test', '{}', now()),
  ('00000000-0000-0000-0000-000000000009', 'email-removed@example.test', '{}', now()),
  ('00000000-0000-0000-0000-000000000010', 'inactive-subscription@example.test', '{}', now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000011', 'deactivated-owner@example.test', '{}', now() - interval '1 day');

-- Model an Auth identity that was created with email and later lost it. This
-- keeps the trigger-created pristine profile while exercising NULL Auth email.
UPDATE auth.users SET email = NULL
WHERE id = '00000000-0000-0000-0000-000000000009';

UPDATE public.profiles SET role = 'owner', dealership_id = NULL
WHERE id = '00000000-0000-0000-0000-000000000001';
UPDATE public.profiles SET role = 'dealer_admin', dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
WHERE id = '00000000-0000-0000-0000-000000000002';
UPDATE public.profiles SET dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
WHERE id IN (
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000005'
);
UPDATE public.profiles SET dealership_id = 'bbbbbbbb-0000-0000-0000-000000000001'
WHERE id = '00000000-0000-0000-0000-000000000004';
UPDATE public.profiles SET dealership_id = 'cccccccc-0000-0000-0000-000000000001'
WHERE id = '00000000-0000-0000-0000-000000000006';
UPDATE public.profiles SET dealership_id = 'dddddddd-0000-0000-0000-000000000001'
WHERE id = '00000000-0000-0000-0000-000000000010';
UPDATE public.profiles SET status = 'deactivated'
WHERE id = '00000000-0000-0000-0000-000000000005';
UPDATE public.profiles SET role = 'owner', status = 'deactivated'
WHERE id = '00000000-0000-0000-0000-000000000011';

-- These fixtures model established accounts. Newly trigger-created accounts
-- remain password-gated unless an explicit onboarding path completes them.
UPDATE public.user_onboarding
SET onboarding_method = 'existing',
    onboarding_state = 'complete',
    password_change_required = false,
    password_changed_at = now(),
    completed_at = now()
WHERE profile_id IN (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000005',
  '00000000-0000-0000-0000-000000000006',
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000011'
);

-- Dealer Admin A is explicitly assigned to two active dealerships. An extra
-- fixture row for Staff A proves that staff remain limited to their primary
-- dealership even if assignment data drifts.
INSERT INTO public.profile_dealerships (profile_id, dealership_id) VALUES
  ('00000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001');

INSERT INTO public.vehicles (id, dealership_id, vin, make, model) VALUES
  ('10000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'VIN-A', 'Test', 'A'),
  ('10000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', 'VIN-B', 'Test', 'B'),
  ('10000000-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001', 'VIN-S', 'Test', 'S'),
  ('10000000-0000-0000-0000-000000000004', 'dddddddd-0000-0000-0000-000000000001', 'VIN-I', 'Test', 'I');

INSERT INTO public.photos (id, vehicle_id, image_url) VALUES
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'https://example.test/a.jpg'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'https://example.test/b.jpg');

INSERT INTO public.documents (id, dealership_id, name, image_url) VALUES
  ('20000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Doc A', 'https://example.test/doc-a.jpg'),
  ('20000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', 'Doc B', 'https://example.test/doc-b.jpg');

INSERT INTO storage.objects (bucket_id, name) VALUES
  ('vehicle-photos', '10000000-0000-0000-0000-000000000001/existing-a.jpg'),
  ('vehicle-photos', '10000000-0000-0000-0000-000000000002/existing-b.jpg');

-- Prove ordinary assertions cannot silently bypass RLS.
SELECT test.assert_true(
  (SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname = 'authenticated'),
  'authenticated is neither superuser nor BYPASSRLS'
);
SELECT test.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_roles AS r ON r.oid = c.relowner
    WHERE n.nspname IN ('public', 'storage')
      AND c.relname IN (
        'profiles', 'dealerships', 'vehicles', 'photos', 'overlay_templates',
        'documents', 'vehicle_documents', 'backdrops', 'impersonation_logs',
        'user_invitations', 'profile_dealerships', 'user_onboarding',
        'user_account_operations', 'user_account_operation_dealerships',
        'audit_events', 'platform_settings', 'dealership_settings', 'objects'
      )
      AND r.rolname = 'authenticated'
  ),
  'authenticated does not own protected tables'
);
SELECT test.assert_true(
  (
    SELECT count(*) = 18
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'storage')
      AND c.relname IN (
        'profiles', 'dealerships', 'vehicles', 'photos', 'overlay_templates',
        'documents', 'vehicle_documents', 'backdrops', 'impersonation_logs',
        'user_invitations', 'profile_dealerships', 'user_onboarding',
        'user_account_operations', 'user_account_operation_dealerships',
        'audit_events', 'platform_settings', 'dealership_settings', 'objects'
      )
      AND c.relrowsecurity
  ),
  'RLS is enabled on every protected table'
);

SET ROLE authenticated;
SELECT test.assert_true(current_user = 'authenticated', 'ordinary assertions run as authenticated');
SELECT test.assert_true(current_setting('row_security') = 'on', 'row_security is on for ordinary assertions');
RESET ROLE;

SELECT test.assert_true(
  NOT has_function_privilege(
    'authenticated',
    'public.begin_user_provisioning_operation(uuid,uuid,text,text,public.app_role,uuid[])',
    'EXECUTE'
  ),
  'ordinary users cannot execute the provisioning RPC'
);
SELECT test.assert_true(
  NOT has_function_privilege(
    'anon',
    'public.complete_temporary_password_onboarding(uuid)',
    'EXECUTE'
  ),
  'anonymous users cannot execute onboarding completion'
);
SELECT test.assert_true(
  NOT has_table_privilege('authenticated', 'public.user_account_operations', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.user_account_operations', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.user_onboarding', 'UPDATE'),
  'operation writes and onboarding completion are server-only'
);
SELECT test.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE p.prosecdef
      AND n.nspname IN ('public', 'private')
      AND p.proname IN (
        'begin_user_provisioning_operation',
        'mark_user_account_operation',
        'finalize_user_provisioning_operation',
        'begin_temporary_password_reset_operation',
        'finalize_temporary_password_reset_operation',
        'contain_temporary_password_reset_operation',
        'complete_temporary_password_onboarding',
        'admin_set_platform_setting',
        'admin_set_dealership_setting',
        'enqueue_background_job',
        'worker_claim_background_job',
        'worker_heartbeat_background_job',
        'worker_complete_background_job',
        'worker_fail_background_job',
        'worker_get_queue_metrics'
      )
      AND COALESCE(array_to_string(p.proconfig, ','), '') NOT LIKE '%search_path=%'
  ),
  'new security-definer functions have a fixed search path'
);

-- Owner starts an idempotent multi-dealership administrator operation.
SET ROLE service_role;
SELECT public.begin_user_provisioning_operation(
  '00000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  'provisioned-admin@example.test',
  'Provisioned Admin',
  'dealer_admin',
  ARRAY[
    'aaaaaaaa-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000001'
  ]::uuid[]
);
RESET ROLE;

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (
  '00000000-0000-0000-0000-000000000012',
  'provisioned-admin@example.test',
  '{"full_name":"Provisioned Admin"}'::jsonb
);

SET ROLE service_role;
SELECT public.mark_user_account_operation(
  '00000000-0000-0000-0000-000000000001',
  (SELECT id FROM public.user_account_operations
   WHERE idempotency_key = '90000000-0000-0000-0000-000000000001'),
  'auth_updated',
  '00000000-0000-0000-0000-000000000012',
  NULL
);
SELECT public.finalize_user_provisioning_operation(
  '00000000-0000-0000-0000-000000000001',
  (SELECT id FROM public.user_account_operations
   WHERE idempotency_key = '90000000-0000-0000-0000-000000000001'),
  '00000000-0000-0000-0000-000000000012'
);
SELECT test.assert_true(
  (SELECT role = 'dealer_admin' AND dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
   FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000012'),
  'owner provisioning assigns the approved dealer role and primary dealership'
);
SELECT test.assert_true(
  (SELECT count(*) = 2 FROM public.profile_dealerships
   WHERE profile_id = '00000000-0000-0000-0000-000000000012'),
  'owner provisioning atomically assigns multiple dealerships to an administrator'
);
SELECT test.assert_true(
  (SELECT password_change_required AND onboarding_state = 'password_change_required'
   FROM public.user_onboarding WHERE profile_id = '00000000-0000-0000-0000-000000000012'),
  'provisioned account is password-gated'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000012';
SELECT test.assert_true((SELECT count(*) = 0 FROM public.vehicles), 'temporary account cannot read business data');
SELECT test.assert_true((SELECT count(*) = 1 FROM public.user_onboarding), 'temporary account can read only its onboarding state');
SELECT test.assert_true((SELECT count(*) = 1 FROM public.profiles), 'temporary account can read only its own profile');
RESET ROLE;

SET ROLE service_role;
SELECT public.complete_temporary_password_onboarding('00000000-0000-0000-0000-000000000012');
RESET ROLE;
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000012';
SELECT test.assert_true((SELECT count(*) = 2 FROM public.vehicles), 'completed administrator can read assigned dealerships');
RESET ROLE;

-- Resetting credentials restores the database gate immediately, even while a
-- caller continues using the same simulated JWT identity.
SET ROLE service_role;
SELECT public.begin_temporary_password_reset_operation(
  '00000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000012'
);
SELECT test.expect_sqlstate(
  $$SELECT public.begin_temporary_password_reset_operation(
    '00000000-0000-0000-0000-000000000001',
    '90000000-0000-0000-0000-000000000013',
    '00000000-0000-0000-0000-000000000012'
  )$$,
  'P0001',
  'concurrent password resets for one target are serialized'
);
SELECT test.expect_sqlstate(
  $$UPDATE public.profiles
    SET dealership_id = 'bbbbbbbb-0000-0000-0000-000000000001'
    WHERE id = '00000000-0000-0000-0000-000000000012'$$,
  'P0001',
  'tenant access cannot move while a credential reset is in progress'
);
RESET ROLE;
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000012';
SELECT test.assert_true(
  (SELECT count(*) = 0 FROM public.vehicles),
  'reset start contains an already-issued identity before the external Auth update'
);
RESET ROLE;
SET ROLE service_role;
SELECT public.mark_user_account_operation(
  '00000000-0000-0000-0000-000000000001',
  (SELECT id FROM public.user_account_operations
   WHERE idempotency_key = '90000000-0000-0000-0000-000000000002'),
  'auth_updated',
  '00000000-0000-0000-0000-000000000012',
  NULL
);
SELECT public.finalize_temporary_password_reset_operation(
  '00000000-0000-0000-0000-000000000001',
  (SELECT id FROM public.user_account_operations
   WHERE idempotency_key = '90000000-0000-0000-0000-000000000002')
);
RESET ROLE;
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000012';
SELECT test.assert_true((SELECT count(*) = 0 FROM public.vehicles), 'credential reset immediately re-blocks an active identity');
RESET ROLE;

-- Dealer Admin A may create staff only in an assigned active dealership.
SET ROLE service_role;
SELECT public.begin_user_provisioning_operation(
  '00000000-0000-0000-0000-000000000002',
  '90000000-0000-0000-0000-000000000003',
  'admin-created-staff@example.test',
  'Admin Created Staff',
  'staff',
  ARRAY['aaaaaaaa-0000-0000-0000-000000000001']::uuid[]
);
SELECT test.expect_sqlstate(
  $$SELECT public.begin_user_provisioning_operation(
    '00000000-0000-0000-0000-000000000002',
    '90000000-0000-0000-0000-000000000004',
    'forbidden-admin@example.test', 'Forbidden Admin', 'dealer_admin',
    ARRAY['aaaaaaaa-0000-0000-0000-000000000001']::uuid[])$$,
  'P0001',
  'dealer administrator cannot create another administrator'
);
SELECT test.expect_sqlstate(
  $$SELECT public.begin_user_provisioning_operation(
    '00000000-0000-0000-0000-000000000002',
    '90000000-0000-0000-0000-000000000005',
    'cross-tenant-staff@example.test', 'Cross Tenant Staff', 'staff',
    ARRAY['cccccccc-0000-0000-0000-000000000001']::uuid[])$$,
  'P0001',
  'dealer administrator cannot provision outside assigned active dealerships'
);
RESET ROLE;

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (
  '00000000-0000-0000-0000-000000000013',
  'admin-created-staff@example.test',
  '{"full_name":"Admin Created Staff"}'::jsonb
);
SET ROLE service_role;
SELECT public.finalize_user_provisioning_operation(
  '00000000-0000-0000-0000-000000000002',
  (SELECT id FROM public.user_account_operations
   WHERE idempotency_key = '90000000-0000-0000-0000-000000000003'),
  '00000000-0000-0000-0000-000000000013'
);
SELECT test.assert_true(
  (SELECT role = 'staff' AND dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
   FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000013'),
  'dealer administrator provisioning produces scoped staff access'
);

SELECT test.assert_true(
  (
    public.begin_user_provisioning_operation(
      '00000000-0000-0000-0000-000000000001',
      '90000000-0000-0000-0000-000000000001',
      'provisioned-admin@example.test', 'Provisioned Admin', 'dealer_admin',
      ARRAY[
        'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001'
      ]::uuid[]
    )->>'operation_id'
  ) = (
    SELECT id::text FROM public.user_account_operations
    WHERE idempotency_key = '90000000-0000-0000-0000-000000000001'
  ),
  'same idempotency key returns the original completed operation'
);
SELECT test.expect_sqlstate(
  $$SELECT public.begin_user_provisioning_operation(
    '00000000-0000-0000-0000-000000000001',
    '90000000-0000-0000-0000-000000000001',
    'different@example.test', 'Different Request', 'staff',
    ARRAY['aaaaaaaa-0000-0000-0000-000000000001']::uuid[])$$,
  'P0001',
  'idempotency key cannot be reused for different input'
);
SELECT test.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.audit_events
    WHERE payload::text ~* 'password|credential|token|secret'
  ),
  'audit payloads contain no credentials or tokens'
);
RESET ROLE;

-- Active staff A: safe self-service succeeds; security fields and tenant B fail.
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT test.assert_row_count(
  $$UPDATE public.profiles SET full_name = 'Staff A' WHERE id = '00000000-0000-0000-0000-000000000003'$$,
  1,
  'active staff can update their own full name'
);
SELECT test.expect_sqlstate(
  $$UPDATE public.profiles SET role = 'owner' WHERE id = '00000000-0000-0000-0000-000000000003'$$,
  '42501',
  'staff cannot change their own role'
);
SELECT test.expect_sqlstate(
  $$UPDATE public.profiles SET dealership_id = 'bbbbbbbb-0000-0000-0000-000000000001' WHERE id = '00000000-0000-0000-0000-000000000003'$$,
  '42501',
  'staff cannot change their own dealership'
);
SELECT test.assert_true((SELECT count(*) = 1 FROM public.vehicles), 'staff A sees only dealer A vehicles');
SELECT test.assert_true(
  (SELECT count(*) = 1 FROM public.dealerships),
  'staff A cannot use an extra assignment outside their primary dealership'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.profile_dealerships (profile_id, dealership_id) VALUES ('00000000-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001')$$,
  '42501',
  'staff cannot assign themselves to another dealership'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.vehicles (dealership_id, make) VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'Cross tenant')$$,
  '42501',
  'staff A cannot insert a dealer B vehicle'
);
SELECT test.expect_sqlstate(
  $$UPDATE public.vehicles SET dealership_id = 'bbbbbbbb-0000-0000-0000-000000000001' WHERE id = '10000000-0000-0000-0000-000000000001'$$,
  '42501',
  'vehicle UPDATE WITH CHECK prevents tenant reassignment'
);
SELECT test.expect_sqlstate(
  $$DELETE FROM public.vehicles WHERE id = '10000000-0000-0000-0000-000000000002'$$,
  '42501',
  'ordinary users cannot bypass the controlled vehicle deletion workflow'
);
SELECT test.assert_row_count(
  $$UPDATE public.photos SET shot_type = 'tampered' WHERE id = '30000000-0000-0000-0000-000000000002'$$,
  0,
  'staff A cannot update dealer B photos'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.vehicle_documents (vehicle_id, document_id) VALUES ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002')$$,
  '42501',
  'staff A cannot attach a dealer B document'
);
SELECT test.assert_row_count(
  $$INSERT INTO public.vehicle_documents (vehicle_id, document_id) VALUES ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001')$$,
  1,
  'staff A can attach a dealer A document'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('vehicle-photos', '10000000-0000-0000-0000-000000000001/staff-a.jpg')$$,
  '42501',
  'browser users cannot bypass path-scoped private upload targets'
);
SELECT test.assert_row_count(
  $$UPDATE storage.objects SET name = '10000000-0000-0000-0000-000000000001/staff-a-renamed.jpg' WHERE bucket_id = 'vehicle-photos' AND name = '10000000-0000-0000-0000-000000000001/staff-a.jpg'$$,
  0,
  'browser users cannot overwrite private originals'
);
SELECT test.assert_row_count(
  $$UPDATE storage.objects SET name = '10000000-0000-0000-0000-000000000002/hidden-update.jpg' WHERE bucket_id = 'vehicle-photos' AND name = '10000000-0000-0000-0000-000000000002/existing-b.jpg'$$,
  0,
  'Storage UPDATE USING hides another tenant object'
);
SELECT test.assert_row_count(
  $$DELETE FROM storage.objects WHERE bucket_id = 'vehicle-photos' AND name = '10000000-0000-0000-0000-000000000002/existing-b.jpg'$$,
  0,
  'staff A cannot delete another tenant Storage object'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('vehicle-photos', '10000000-0000-0000-0000-000000000002/cross-tenant.jpg')$$,
  '42501',
  'staff A cannot upload to a dealer B vehicle path'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('overlays', 'not-a-uuid/bad-path.png')$$,
  '42501',
  'malformed Storage tenant paths fail closed'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('overlays', '/empty-segment.png')$$,
  '42501',
  'empty Storage tenant segments fail closed'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('overlays', 'aaaaaaaa-0000-0000-0000-000000000001-prefix/misleading.png')$$,
  '42501',
  'misleading Storage tenant prefixes fail closed'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('overlays', 'aaaaaaaa-0000-0000-0000-000000000001%2Fescape/encoded.png')$$,
  '42501',
  'URL-encoded Storage separators fail closed'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('overlays', 'bbbbbbbb-0000-0000-0000-000000000001/nested/cross-tenant.png')$$,
  '42501',
  'unexpected Storage depth cannot cross tenants'
);
SELECT test.assert_row_count(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('overlays', 'aaaaaaaa-0000-0000-0000-000000000001/nested/bbbbbbbb-0000-0000-0000-000000000001.png')$$,
  1,
  'authorized first segment controls access regardless of user filename'
);
SELECT test.assert_row_count(
  $$DELETE FROM storage.objects WHERE bucket_id = 'vehicle-photos' AND name = '10000000-0000-0000-0000-000000000001/staff-a-renamed.jpg'$$,
  0,
  'browser users cannot delete retained originals'
);
RESET ROLE;

-- Dealer administrator A cannot mutate protected profile columns directly.
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
SELECT test.assert_true(
  (SELECT count(*) = 2 FROM public.dealerships),
  'dealer administrator sees every active assigned dealership'
);
SELECT test.assert_true(
  (SELECT count(*) = 2 FROM public.vehicles),
  'dealer administrator sees tenant data across assigned dealerships'
);
SELECT test.expect_sqlstate(
  $$UPDATE public.profiles SET role = 'owner' WHERE id = '00000000-0000-0000-0000-000000000002'$$,
  '42501',
  'dealer administrator cannot promote themselves to owner'
);
SELECT test.expect_sqlstate(
  $$UPDATE public.profiles SET role = 'owner' WHERE id = '00000000-0000-0000-0000-000000000003'$$,
  '42501',
  'dealer administrator cannot promote another user to owner'
);
SELECT test.expect_sqlstate(
  $$UPDATE public.profiles SET dealership_id = 'bbbbbbbb-0000-0000-0000-000000000001' WHERE id = '00000000-0000-0000-0000-000000000003'$$,
  '42501',
  'dealer administrator cannot move users across dealerships'
);
SELECT test.assert_row_count(
  $$INSERT INTO public.vehicles (id, dealership_id, make) VALUES ('10000000-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin workflow')$$,
  1,
  'dealer administrator can create a vehicle in their dealership'
);
SELECT test.assert_true(
  public.delete_vehicle('10000000-0000-0000-0000-000000000010')->>'status' = 'deleted',
  'dealer administrator can delete a vehicle through the controlled workflow'
);
SELECT test.assert_row_count(
  $$INSERT INTO public.vehicles (id, dealership_id, make) VALUES ('10000000-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001', 'Second assigned dealer')$$,
  1,
  'dealer administrator can create tenant data in a second assigned dealership'
);
SELECT test.assert_true(
  public.delete_vehicle('10000000-0000-0000-0000-000000000011')->>'status' = 'deleted',
  'dealer administrator can administer a second assigned dealership through the workflow'
);
SELECT test.assert_row_count(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('overlays', 'bbbbbbbb-0000-0000-0000-000000000001/admin-b.png')$$,
  1,
  'dealer administrator can upload to a second assigned dealership path'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('overlays', 'cccccccc-0000-0000-0000-000000000001/admin-suspended.png')$$,
  '42501',
  'dealer administrator cannot use an unassigned or suspended dealership path'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.profile_dealerships (profile_id, dealership_id) VALUES ('00000000-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001')$$,
  '42501',
  'dealer administrator cannot expand their own assignments'
);
RESET ROLE;

-- Active profile with an inactive subscription is denied like a suspended dealer.
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000010';
SELECT test.assert_true((SELECT count(*) = 0 FROM public.vehicles), 'inactive-subscription user cannot read tenant vehicles');
SELECT test.expect_sqlstate(
  $$INSERT INTO public.vehicles (dealership_id, make) VALUES ('dddddddd-0000-0000-0000-000000000001', 'Blocked')$$,
  '42501',
  'inactive-subscription user cannot insert tenant data'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', 'dddddddd-0000-0000-0000-000000000001/blocked.png')$$,
  '42501',
  'inactive-subscription user cannot upload Storage objects'
);
RESET ROLE;

-- Dealer B is isolated from dealer A.
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000004';
SELECT test.assert_true((SELECT count(*) = 1 FROM public.vehicles), 'staff B sees only dealer B vehicles');
SELECT test.assert_row_count(
  $$UPDATE public.photos SET shot_type = 'dealer-b' WHERE id = '30000000-0000-0000-0000-000000000002'$$,
  1,
  'staff B can update a dealer B photo'
);
RESET ROLE;

-- Deactivated and suspended users retain JWT-shaped context but no tenant access.
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000005';
SELECT test.assert_true((SELECT count(*) = 0 FROM public.profiles), 'deactivated user cannot read their profile');
SELECT test.assert_true((SELECT count(*) = 0 FROM public.vehicles), 'deactivated user cannot read tenant vehicles');
SELECT test.expect_sqlstate(
  $$INSERT INTO public.vehicles (dealership_id, make) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'Blocked')$$,
  '42501',
  'deactivated user cannot insert tenant data'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('overlays', 'aaaaaaaa-0000-0000-0000-000000000001/deactivated.png')$$,
  '42501',
  'deactivated user cannot upload Storage objects'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000006';
SELECT test.assert_true((SELECT count(*) = 0 FROM public.vehicles), 'suspended-dealership user cannot read tenant vehicles');
SELECT test.expect_sqlstate(
  $$INSERT INTO public.vehicles (dealership_id, make) VALUES ('cccccccc-0000-0000-0000-000000000001', 'Blocked')$$,
  '42501',
  'suspended-dealership user cannot insert tenant data'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('backdrops', 'cccccccc-0000-0000-0000-000000000001/suspended.png')$$,
  '42501',
  'suspended-dealership user cannot upload Storage objects'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000011';
SELECT test.assert_true((SELECT count(*) = 0 FROM public.vehicles), 'deactivated owner has no global reads');
SELECT test.assert_row_count(
  $$UPDATE public.dealerships SET phone = 'blocked' WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  0,
  'deactivated owner has no global mutations'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('dealership-logos', 'blocked-owner.png')$$,
  '42501',
  'deactivated owner cannot mutate owner-only Storage'
);
RESET ROLE;

-- Active platform owner retains explicitly intended global administration.
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
SELECT test.assert_true((SELECT count(*) = 4 FROM public.vehicles), 'platform owner can view all dealership vehicles');
SELECT test.assert_row_count(
  $$UPDATE public.dealerships SET phone = '555-0100' WHERE id = 'cccccccc-0000-0000-0000-000000000001'$$,
  1,
  'platform owner can administer a suspended dealership'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.user_invitations (email, full_name, role, dealership_id, invited_by, token) VALUES ('owner-invite@example.test', 'Owner Invite', 'owner', NULL, '00000000-0000-0000-0000-000000000001', 'owner-invite')$$,
  '42501',
  'browser invitation writes cannot create platform owners'
);
RESET ROLE;

-- The server-only service role remains the authorized profile administration path.
SET ROLE service_role;
UPDATE public.profiles
SET dealership_id = NULL
WHERE id = '00000000-0000-0000-0000-000000000002';
SELECT test.assert_true(
  (
    SELECT count(*) = 2
    FROM public.profile_dealerships
    WHERE profile_id = '00000000-0000-0000-0000-000000000002'
  ),
  'clearing an administrator primary preserves their remaining assignments'
);
UPDATE public.profiles
SET dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
WHERE id = '00000000-0000-0000-0000-000000000002';
SELECT public.admin_update_user_account_access(
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000003',
  'Staff A',
  'dealer_admin'::public.app_role,
  ARRAY[
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid
  ]
);
SELECT test.assert_true(
  (
    SELECT count(*) = 2
    FROM public.profile_dealerships
    WHERE profile_id = '00000000-0000-0000-0000-000000000003'
  ),
  'server-only account administration replaces dealership assignments atomically'
);
SELECT public.admin_update_user_account_access(
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000003',
  'Staff A',
  'staff'::public.app_role,
  ARRAY['aaaaaaaa-0000-0000-0000-000000000001'::uuid]
);
SELECT test.assert_row_count(
  $$UPDATE public.profiles SET role = 'dealer_admin' WHERE id = '00000000-0000-0000-0000-000000000003'$$,
  1,
  'service role can perform an authorized role change'
);
SELECT test.assert_row_count(
  $$UPDATE public.profiles SET role = 'staff' WHERE id = '00000000-0000-0000-0000-000000000003'$$,
  1,
  'service role can restore the test fixture role'
);
RESET ROLE;

-- Invitation acceptance can initialize a pristine profile but cannot create an owner.
INSERT INTO public.user_invitations (
  email, full_name, role, dealership_id, invited_by, token
) VALUES
  ('invitee@example.test', 'Invitee', 'staff', 'aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'valid-invite'),
  ('blocked-owner@example.test', 'Blocked Owner', 'owner', NULL, '00000000-0000-0000-0000-000000000001', 'blocked-owner-invite'),
  ('email-removed@example.test', 'Email Removed', 'staff', 'aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'null-email-invite');

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000007';
SELECT test.assert_true(
  (public.accept_invitation('valid-invite')->>'ok')::boolean,
  'pristine invited user can accept an active dealership assignment'
);
RESET ROLE;
SELECT test.assert_true(
  (SELECT dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND role = 'staff'
   FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000007'),
  'valid invitation stores the approved role and dealership'
);
SELECT test.assert_true(
  (
    SELECT count(*) = 1
    FROM public.profile_dealerships
    WHERE profile_id = '00000000-0000-0000-0000-000000000007'
      AND dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
  ),
  'invitation acceptance creates the initial normalized dealership assignment'
);

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000008';
SELECT test.expect_sqlstate(
  $$SELECT public.accept_invitation('blocked-owner-invite')$$,
  'P0001',
  'invitation acceptance rejects an owner role'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000009';
SELECT test.expect_sqlstate(
  $$SELECT public.accept_invitation('null-email-invite')$$,
  'P0001',
  'invitation acceptance rejects an Auth identity with no email'
);
RESET ROLE;

-- Structural least-privilege assertions.
SELECT test.assert_true(
  NOT has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated role cannot resolve private authorization helpers directly'
);
SELECT test.assert_true(
  to_regprocedure('public.has_role(uuid,public.app_role)') IS NULL,
  'legacy arbitrary-user role helper is removed'
);
SELECT test.assert_true(
  to_regprocedure('public.get_user_dealership(uuid)') IS NULL,
  'legacy arbitrary-user dealership helper is removed'
);
SELECT test.assert_true(
  (
    SELECT array_agg(column_name::text ORDER BY column_name::text) = ARRAY['full_name']::text[]
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND grantee = 'authenticated'
      AND privilege_type = 'UPDATE'
  ),
  'authenticated receives UPDATE privilege only on profiles.full_name'
);
SELECT test.assert_true(
  NOT has_table_privilege('authenticated', 'public.profiles', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.profiles', 'DELETE'),
  'authenticated has no direct profile INSERT or DELETE privilege'
);
SELECT test.assert_true(
  NOT has_table_privilege('authenticated', 'public.profile_dealerships', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.profile_dealerships', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.profile_dealerships', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.profile_dealerships', 'DELETE'),
  'authenticated has no direct dealership-assignment privileges'
);
SELECT test.assert_true(
  NOT has_function_privilege(
    'authenticated',
    'public.admin_update_user_account_access(uuid,uuid,text,public.app_role,uuid[])',
    'EXECUTE'
  )
    AND has_function_privilege(
      'service_role',
      'public.admin_update_user_account_access(uuid,uuid,text,public.app_role,uuid[])',
      'EXECUTE'
    ),
  'only service_role can execute the atomic account-assignment function'
);
SELECT test.assert_true(
  NOT has_table_privilege('anon', 'public.profiles', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.vehicles', 'SELECT'),
  'anonymous users have no public-table access'
);
SELECT test.assert_true(
  NOT has_function_privilege('anon', 'private.current_user_is_active_owner()', 'EXECUTE')
    AND has_function_privilege('authenticated', 'private.current_user_is_active_owner()', 'EXECUTE'),
  'private helper execution is granted only to the policy role'
);

-- Photo capture sessions exercise ordinary-user grants, RLS checks, Storage
-- paths, completion RPC authorization, and cross-tenant isolation.
INSERT INTO public.photo_capture_sessions (
  id, dealership_id, vehicle_id, vin, mode, created_by
) VALUES (
  '40000000-0000-0000-0000-000000000002',
  'bbbbbbbb-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  '1M8GDM9AXKP042788',
  'guided',
  '00000000-0000-0000-0000-000000000004'
);
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT public.start_photo_capture_session(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  NULL,
  'guided'
);
SELECT public.start_photo_capture_session(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  NULL,
  'guided'
);
SELECT test.assert_true(
  (SELECT count(*) = 1
   FROM public.photo_capture_sessions
   WHERE vehicle_id = '10000000-0000-0000-0000-000000000001'
     AND created_by = '00000000-0000-0000-0000-000000000003'
     AND mode = 'guided'
     AND status = 'in_progress'),
  'photographer starts and reads one idempotent guided capture session'
);
SELECT test.expect_sqlstate(
  $$SELECT public.start_photo_capture_session(
      'bbbbbbbb-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002',
      NULL,
      'guided'
    )$$,
  '42501',
  'capture start RPC denies a staff user outside its active primary store'
);
SELECT test.assert_true(
  (public.get_current_user_store_capabilities(
    'aaaaaaaa-0000-0000-0000-000000000001'
  )->>'capture')::boolean
  AND NOT (public.get_current_user_store_capabilities(
    'aaaaaaaa-0000-0000-0000-000000000001'
  )->>'settings')::boolean,
  'photographer capability discovery allows capture without exposing settings'
);
SELECT test.assert_true(
  (SELECT count(*) = 0 FROM public.list_payout_eligible_profiles(
    'aaaaaaaa-0000-0000-0000-000000000001'
  )),
  'photographer cannot enumerate payout-eligible coworkers'
);
RESET ROLE;
DELETE FROM public.photo_capture_sessions
WHERE vehicle_id = '10000000-0000-0000-0000-000000000001'
  AND created_by = '00000000-0000-0000-0000-000000000003'
  AND mode = 'guided'
  AND status = 'in_progress';
INSERT INTO public.photo_capture_sessions (
  id, dealership_id, vehicle_id, vin, mode, created_by
) VALUES (
  '40000000-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '1HGCM82633A004353',
  'bulk',
  '00000000-0000-0000-0000-000000000003'
);
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT test.expect_sqlstate(
  $$INSERT INTO public.photo_capture_sessions (
      dealership_id, vin, mode, created_by
    ) VALUES (
      'bbbbbbbb-0000-0000-0000-000000000001', '1M8GDM9AXKP042788', 'bulk',
      '00000000-0000-0000-0000-000000000003'
    )$$,
  '42501',
  'staff cannot create a bulk package in another tenant'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.photos (
      vehicle_id, image_url, capture_session_id
    ) VALUES (
      '10000000-0000-0000-0000-000000000001',
      'https://example.test/forged-session.jpg',
      '40000000-0000-0000-0000-000000000002'
    )$$,
  '42501',
  'photo rows cannot attach an authorized vehicle to another tenant capture session'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.bulk_photo_items (
      id, session_id, image_url, storage_path, created_by
    ) VALUES (
      '41000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      'https://example.test/raw.jpg',
      '40000000-0000-0000-0000-000000000001/originals/raw.jpg',
      '00000000-0000-0000-0000-000000000003'
    )$$,
  '42501',
  'browser users cannot finalize bulk media rows directly'
);
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name)
VALUES ('vehicle-photos', '40000000-0000-0000-0000-000000000001/originals/raw.jpg');
INSERT INTO public.media_assets (
  id, organization_id, dealership_id, capture_session_id, uploaded_by,
  source_type, media_kind, media_category, original_filename, content_type,
  byte_size, checksum_sha256, storage_bucket, storage_object_path, migration_state
)
SELECT
  '42000000-0000-0000-0000-000000000001', d.organization_id, d.id,
  '40000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000003', 'bulk', 'photo', 'exterior',
  'raw.jpg', 'image/jpeg', 4, repeat('a', 64), 'vehicle-photos',
  '40000000-0000-0000-0000-000000000001/originals/raw.jpg', 'legacy'
FROM public.dealerships d
WHERE d.id = 'aaaaaaaa-0000-0000-0000-000000000001';
INSERT INTO public.media_variants (
  id, media_asset_id, variant_type, image_url, storage_bucket, storage_path,
  content_type, original_filename, byte_size, checksum, variant_role, processing_status
) VALUES (
  '43000000-0000-0000-0000-000000000001',
  '42000000-0000-0000-0000-000000000001', 'original',
  'private-media://43000000-0000-0000-0000-000000000001', 'vehicle-photos',
  '40000000-0000-0000-0000-000000000001/originals/raw.jpg', 'image/jpeg',
  'raw.jpg', 4, repeat('a', 64), 'source', 'completed'
);
INSERT INTO public.bulk_photo_items (
  id, session_id, image_url, storage_path, created_by, media_asset_id
) VALUES (
  '41000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  'private-media://43000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001/originals/raw.jpg',
  '00000000-0000-0000-0000-000000000003',
  '42000000-0000-0000-0000-000000000001'
);
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT test.expect_sqlstate(
  $$UPDATE public.photo_capture_sessions SET status = 'completed'
    WHERE id = '40000000-0000-0000-0000-000000000001'$$,
  '42501',
  'browser cannot forge capture-session completion metadata'
);
SELECT public.complete_photo_capture_session('40000000-0000-0000-0000-000000000001');
SELECT test.assert_true(
  (SELECT status = 'completed'
     AND completed_by = '00000000-0000-0000-0000-000000000003'
     AND completed_at IS NOT NULL
   FROM public.photo_capture_sessions
   WHERE id = '40000000-0000-0000-0000-000000000001'),
  'completion RPC records trusted actor and timestamp'
);
SELECT test.expect_sqlstate(
  $$SELECT public.complete_photo_capture_session(
      '40000000-0000-0000-0000-000000000001'
    )$$,
  '42501',
  'completed capture sessions cannot be replayed'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.bulk_photo_items (
      session_id, image_url, storage_path, created_by
    ) VALUES (
      '40000000-0000-0000-0000-000000000001', 'https://example.test/late.jpg',
      '40000000-0000-0000-0000-000000000001/originals/late.jpg',
      '00000000-0000-0000-0000-000000000003'
    )$$,
  '42501',
  'staff cannot append photos after completion'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000004';
SELECT test.assert_true(
  (SELECT count(*) = 0 FROM public.photo_capture_sessions
   WHERE id = '40000000-0000-0000-0000-000000000001')
  AND (SELECT count(*) = 0 FROM public.bulk_photo_items
   WHERE session_id = '40000000-0000-0000-0000-000000000001'),
  'other-tenant staff cannot read capture packages or their items'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
SELECT public.associate_bulk_photo_session(
  '40000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001'
);
SELECT test.assert_true(
  (SELECT status = 'prepared' AND vehicle_id = '10000000-0000-0000-0000-000000000001'
   FROM public.photo_capture_sessions
   WHERE id = '40000000-0000-0000-0000-000000000001')
  AND (SELECT p.image_url LIKE 'private-media://%'
            AND p.media_asset_id IS NOT NULL
            AND ma.storage_object_path = '40000000-0000-0000-0000-000000000001/originals/raw.jpg'
   FROM public.photos p
   JOIN public.media_assets ma ON ma.id = p.media_asset_id
   WHERE p.capture_session_id = '40000000-0000-0000-0000-000000000001'),
  'dealer admin associates the package without duplicating its physical media object'
);
SELECT test.expect_sqlstate(
  $$SELECT public.associate_bulk_photo_session(
      '40000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001'
    )$$,
  '42501',
  'prepared bulk associations cannot be replayed'
);
RESET ROLE;

-- NetLook-replacement foundation: originals, readiness, role capabilities,
-- generated documents, durable production activity, and payout isolation.
SELECT test.assert_true(
  (SELECT count(*) = 1 FROM public.media_variants
   WHERE photo_id = '30000000-0000-0000-0000-000000000001'
     AND variant_type = 'original'
     AND image_url = 'https://example.test/a.jpg'),
  'every photo receives exactly one immutable original media variant'
);
SELECT test.assert_true(
  (SELECT status = 'needs_attention'
     AND reasons @> '[{"key":"vehicle.stock_number"}]'::jsonb
     AND reasons @> '[{"key":"vehicle.price"}]'::jsonb
   FROM public.vehicle_readiness
   WHERE vehicle_id = '10000000-0000-0000-0000-000000000001'),
  'readiness evaluation stores actionable failure reasons'
);

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT test.expect_sqlstate(
  $$INSERT INTO public.vehicles (dealership_id, make)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'Photographer forged vehicle')$$,
  '42501',
  'photographers cannot create inventory records'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.vehicle_equipment (vehicle_id, category, label)
    VALUES ('10000000-0000-0000-0000-000000000001', 'safety', 'Forged feature')$$,
  '42501',
  'photographers cannot edit vehicle specifications'
);
SELECT test.expect_sqlstate(
  $$SELECT public.generate_vehicle_document(
      '10000000-0000-0000-0000-000000000001', 'window_sticker')$$,
  '42501',
  'photographers cannot generate controlled vehicle documents'
);
SELECT test.expect_sqlstate(
  $$SELECT public.commit_photo_variant(
      '30000000-0000-0000-0000-000000000001', 'customized',
      'https://example.test/forged.jpg', 'forged.jpg', 'browser-forgery')$$,
  '42501',
  'photographers cannot commit office media variants'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
SELECT public.generate_vehicle_document(
  '10000000-0000-0000-0000-000000000001', 'window_sticker'
);
SELECT test.expect_sqlstate(
  $$SELECT public.commit_photo_variant(
    '30000000-0000-0000-0000-000000000001', 'customized',
    'https://example.test/customized.jpg', 'customized.jpg', 'test-renderer')$$,
  '42501',
  'legacy browser-side variant finalization is disabled'
);
SELECT test.assert_true(
  (SELECT count(*) = 1 FROM public.generated_documents
   WHERE vehicle_id = '10000000-0000-0000-0000-000000000001'
     AND document_type = 'window_sticker' AND status = 'generated')
  AND (SELECT count(*) = 1 FROM public.audit_events
       WHERE event_type = 'vehicle_document.generated'
         AND payload->>'vehicle_id' = '10000000-0000-0000-0000-000000000001')
  AND (SELECT count(*) = 1 FROM public.activity_events
       WHERE event_type = 'vehicle_document.generated'
         AND vehicle_id = '10000000-0000-0000-0000-000000000001'),
  'authorized document generation snapshots vehicle data and emits an audit event'
);
SELECT test.assert_true(
  NOT has_function_privilege('authenticated',
    'public.finalize_private_photo_upload(uuid,uuid,uuid,uuid,text,text,text,text,bigint,integer,integer,text,text,integer,text)',
    'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.commit_private_photo_variant(uuid,uuid,uuid,text,uuid,text,text,text,bigint,integer,integer,text,text)',
    'EXECUTE'),
  'trusted media finalization functions are server-only'
);
SELECT public.create_payout_rule(
  'aaaaaaaa-0000-0000-0000-000000000001',
  'Standard photo shoot', 'photo_shoot', 12.50, CURRENT_DATE, '{}'::jsonb
);
RESET ROLE;

INSERT INTO public.photo_capture_sessions (
  id, dealership_id, vehicle_id, vin, mode, created_by
) VALUES (
  '40000000-0000-0000-0000-000000000003',
  'aaaaaaaa-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '1HGCM82633A004352', 'guided',
  '00000000-0000-0000-0000-000000000003'
);
SET ROLE service_role;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT public.finalize_private_photo_upload(
  '00000000-0000-0000-0000-000000000003',
  '44000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000003',
  'dealer-media-private',
  'stores/aaaaaaaa-0000-0000-0000-000000000001/vehicles/10000000-0000-0000-0000-000000000001/media/44000000-0000-0000-0000-000000000001/original/shoot.jpg',
  'shoot.jpg', 'image/jpeg', 4, 1, 1, repeat('b', 64), 'Front', 0, 'capture'
);
RESET ROLE;
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT public.complete_photo_capture_session('40000000-0000-0000-0000-000000000003');
SELECT test.assert_true(
  (SELECT photo_count = 1 AND completed_by = '00000000-0000-0000-0000-000000000003'
     AND duration_seconds >= 0
   FROM public.photo_capture_sessions
   WHERE id = '40000000-0000-0000-0000-000000000003')
  AND (SELECT amount = 12.50 AND status = 'pending'
       AND rule_snapshot->>'version' = '1'
       FROM public.payout_entries
       WHERE photo_shoot_id = '40000000-0000-0000-0000-000000000003')
  AND (SELECT count(*) = 1 FROM public.activity_events
       WHERE photo_shoot_id = '40000000-0000-0000-0000-000000000003'
         AND event_type = 'photo_shoot.completed')
  AND (SELECT count(*) = 1 FROM public.activity_events
       WHERE photo_shoot_id = '40000000-0000-0000-0000-000000000003'
         AND event_type = 'photo.uploaded'),
  'shoot completion durably snapshots counts, attribution, activity, and payout rule version'
);
SELECT test.expect_sqlstate(
  $$SELECT public.set_payout_status(
      (SELECT id FROM public.payout_entries
       WHERE photo_shoot_id = '40000000-0000-0000-0000-000000000003'),
      'paid')$$,
  '42501',
  'photographers cannot approve or mark payouts paid'
);
SELECT test.expect_sqlstate(
  $$SELECT * FROM public.get_production_payout_report(
      'aaaaaaaa-0000-0000-0000-000000000001',
      current_date - 1,
      current_date + 1,
      NULL)$$,
  '42501',
  'photographers cannot access production payout reports'
);
SELECT test.expect_sqlstate(
  $$SELECT * FROM public.get_daily_activity_report(
      'aaaaaaaa-0000-0000-0000-000000000001',
      current_date - 1,
      current_date + 1)$$,
  '42501',
  'photographers cannot access daily activity reports'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000004';
SELECT test.assert_true(
  (SELECT count(*) = 0 FROM public.payout_entries
   WHERE photo_shoot_id = '40000000-0000-0000-0000-000000000003')
  AND (SELECT count(*) = 0 FROM public.activity_events
       WHERE photo_shoot_id = '40000000-0000-0000-0000-000000000003'),
  'cross-tenant users cannot read production or payout records'
);
SELECT test.expect_sqlstate(
  $$SELECT * FROM public.get_daily_activity_report(
      'aaaaaaaa-0000-0000-0000-000000000001',
      current_date - 1,
      current_date + 1)$$,
  '42501',
  'cross-tenant users cannot access daily activity reports'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
SELECT public.set_payout_status(
  (SELECT id FROM public.payout_entries
   WHERE photo_shoot_id = '40000000-0000-0000-0000-000000000003'),
  'approved'
);
SELECT test.assert_true(
  (SELECT status = 'approved' AND approved_by = '00000000-0000-0000-0000-000000000002'
   FROM public.payout_entries
   WHERE photo_shoot_id = '40000000-0000-0000-0000-000000000003'),
  'authorized administrator can approve a payout with trusted attribution'
);
SELECT test.assert_true(
  (SELECT count(*) = 1
   FROM public.get_production_payout_report(
     'aaaaaaaa-0000-0000-0000-000000000001',
     current_date - 1,
     current_date + 1,
     'approved'
   )
   WHERE employee_id = '00000000-0000-0000-0000-000000000003'
     AND photo_count = 1
     AND payout_status = 'approved'),
  'authorized reporting projection includes trusted employee and shoot totals'
);
SELECT test.assert_true(
  (SELECT count(*) = 1
   FROM public.get_daily_activity_report(
     'aaaaaaaa-0000-0000-0000-000000000001',
     current_date - 1,
     current_date + 1
   )
   WHERE created_by = '00000000-0000-0000-0000-000000000003'
     AND photo_count = 1),
  'authorized daily activity projection includes trusted shoot totals'
);
RESET ROLE;

-- Retail Ready acceptance settings are backend-authorized, tenant-scoped, and
-- immediately reflected in the shared readiness evaluator.
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT test.expect_sqlstate(
  $$SELECT public.save_readiness_configuration(
    'aaaaaaaa-0000-0000-0000-000000000001',
    '[{"key":"vehicle.price","label":"Retail price available","severity":"attention","enabled":true,"applies_to":["used"],"config":{},"sort_order":30}]'::jsonb
  )$$,
  '42501',
  'photographers cannot mutate Retail Ready settings'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.media_variants
    (photo_id, variant_type, image_url, processing_status)
    VALUES ('30000000-0000-0000-0000-000000000001', 'customized',
            'https://example.test/forged.jpg', 'completed')$$,
  '42501',
  'photographers cannot forge processed media variants'
);
SELECT test.expect_sqlstate(
  $$UPDATE public.photos SET image_url = 'https://example.test/forged.jpg'
    WHERE id = '30000000-0000-0000-0000-000000000001'$$,
  '42501',
  'capture users cannot overwrite immutable photo URLs'
);
SELECT test.expect_sqlstate(
  $$SELECT public.create_manual_payout_adjustment(
    'aaaaaaaa-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000003', 5, 'self bonus', current_date
  )$$,
  '42501',
  'photographers cannot create their own payout adjustments'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO public.photos (
      id, vehicle_id, image_url, original_image_url, photo_state, is_main,
      is_cutout, cutout_status, processing_status, review_status
    ) VALUES (
      '30000000-0000-0000-0000-000000000009',
      '10000000-0000-0000-0000-000000000001',
      'https://example.test/raw-upload.jpg', 'https://example.test/forged-original.jpg',
      'customized', true, true, 'completed', 'completed', 'approved'
    )$$,
  '42501',
  'raw capture rows can only be finalized by trusted server logic'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
SELECT public.save_readiness_configuration(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"key":"vehicle.price","label":"Retail price available","severity":"attention","enabled":true,"applies_to":["used"],"config":{},"sort_order":30}]'::jsonb
);
SELECT test.assert_true(
  EXISTS (
    SELECT 1 FROM public.vehicle_readiness,
      LATERAL jsonb_array_elements(reasons) AS reason
    WHERE vehicle_id = '10000000-0000-0000-0000-000000000001'
      AND reason->>'key' = 'vehicle.price'
  ),
  'enabling the price rule immediately re-evaluates affected inventory'
);
SELECT public.save_readiness_configuration(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"key":"vehicle.price","label":"Retail price available","severity":"attention","enabled":false,"applies_to":["used"],"config":{},"sort_order":30}]'::jsonb
);
SELECT test.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.vehicle_readiness,
      LATERAL jsonb_array_elements(reasons) AS reason
    WHERE vehicle_id = '10000000-0000-0000-0000-000000000001'
      AND reason->>'key' = 'vehicle.price'
  ),
  'disabling a store rule removes only that Retail Ready failure reason'
);
SELECT test.expect_sqlstate(
  $$SELECT public.save_photography_configuration(
    'cccccccc-0000-0000-0000-000000000001', 'block', '[]'::jsonb
  )$$,
  '42501',
  'administrators cannot configure an unassigned store'
);
SELECT public.save_photography_configuration(
  'aaaaaaaa-0000-0000-0000-000000000001', 'block',
  '[{"shot_key":"front","label":"Front","guidance":"Centered front view","category":"exterior","required":true,"enabled":true,"minimum_count":1,"applies_to":["new","used","certified"],"sort_order":10}]'::jsonb
);
RESET ROLE;
INSERT INTO public.photo_capture_sessions (
  id, dealership_id, vehicle_id, vin, mode, created_by
) VALUES (
  '40000000-0000-0000-0000-000000000004',
  'aaaaaaaa-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '1HGCM82633A004352', 'guided',
  '00000000-0000-0000-0000-000000000002'
);
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
SELECT test.expect_sqlstate(
  $$SELECT public.complete_photo_capture_session(
    '40000000-0000-0000-0000-000000000004'
  )$$,
  '23514',
  'block-completion policy prevents a silent short shoot'
);
SELECT test.assert_true(
  (SELECT status = 'in_progress' AND completion_policy = 'block'
   FROM public.photo_capture_sessions
   WHERE id = '40000000-0000-0000-0000-000000000004'),
  'failed completion rolls the capture session back intact'
);
SELECT public.save_media_processing_configuration(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"media_category":"exterior","action":"manual_review","enabled":true,"priority":10,"config":{}},{"media_category":"interior","action":"keep_original","enabled":true,"priority":20,"config":{}}]'::jsonb
);
SELECT test.assert_true(
  (SELECT action = 'manual_review' FROM public.media_processing_rules
   WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND media_category = 'exterior')
  AND (SELECT action = 'keep_original' FROM public.media_processing_rules
       WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
         AND media_category = 'interior'),
  'selective processing configuration preserves interior originals'
);
SELECT public.save_document_requirements(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"document_type":"buyers_guide","enabled":true,"required":true,"applies_to":["used","certified"]}]'::jsonb
);
SELECT test.assert_true(
  (SELECT enabled AND required AND applies_to @> ARRAY['used']::text[]
   FROM public.document_requirements
   WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND document_type = 'buyers_guide'),
  'store document requirements persist with explicit vehicle applicability'
);

SELECT public.set_vehicle_primary_asset(
  '10000000-0000-0000-0000-000000000001', 'photo',
  '30000000-0000-0000-0000-000000000001'
);
SELECT test.assert_true(
  (SELECT count(*) = 1 FROM (
    SELECT id FROM public.photos
      WHERE vehicle_id = '10000000-0000-0000-0000-000000000001' AND is_main
    UNION ALL
    SELECT id FROM public.vehicle_documents
      WHERE vehicle_id = '10000000-0000-0000-0000-000000000001' AND is_main
  ) AS main_assets),
  'transactional main-image selection leaves exactly one vehicle primary asset'
);
SELECT public.reorder_vehicle_gallery(
  '10000000-0000-0000-0000-000000000001',
  (
    SELECT jsonb_agg(asset ORDER BY requested_position)
    FROM (
      SELECT jsonb_build_object('type','photo','id',id) AS asset,
             CASE WHEN id = '30000000-0000-0000-0000-000000000001' THEN 0 ELSE 1 END AS requested_position
      FROM public.photos
      WHERE vehicle_id = '10000000-0000-0000-0000-000000000001'
      UNION ALL
      SELECT jsonb_build_object('type','document','id',id), 1000
      FROM public.vehicle_documents
      WHERE vehicle_id = '10000000-0000-0000-0000-000000000001'
    ) AS assets
  )
);
SELECT test.assert_true(
  (SELECT sort_order = 0 FROM public.photos
   WHERE id = '30000000-0000-0000-0000-000000000001')
  AND (SELECT sort_order = (
         SELECT count(*) FROM public.photos
         WHERE vehicle_id = '10000000-0000-0000-0000-000000000001'
       ) FROM public.vehicle_documents
       WHERE vehicle_id = '10000000-0000-0000-0000-000000000001' LIMIT 1),
  'gallery reorder commits a complete unique sequence atomically'
);
SELECT test.expect_sqlstate(
  $$SELECT public.reorder_vehicle_gallery(
    '10000000-0000-0000-0000-000000000001',
    '[{"type":"photo","id":"30000000-0000-0000-0000-000000000001"}]'::jsonb
  )$$,
  '40001',
  'stale partial gallery reorder fails without corrupting the current order'
);

SET ROLE service_role;
UPDATE public.profile_dealerships
SET payout_eligible = false
WHERE profile_id = '00000000-0000-0000-0000-000000000003'
  AND dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SET ROLE authenticated;
SELECT test.expect_sqlstate(
  $$SELECT public.create_manual_payout_adjustment(
    'aaaaaaaa-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000003', 5.00,
    'Should not be payable', current_date
  )$$,
  '42501',
  'manual adjustments require an active payout-eligible store assignment'
);
SET ROLE service_role;
UPDATE public.profile_dealerships
SET payout_eligible = true
WHERE profile_id = '00000000-0000-0000-0000-000000000003'
  AND dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SET ROLE authenticated;

SELECT public.create_manual_payout_adjustment(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000003', -2.50,
  'Documented reshoot deduction', current_date
);
SELECT test.expect_sqlstate(
  $$SELECT public.set_payout_status(
    (SELECT id FROM public.payout_entries
     WHERE task_type = 'manual' ORDER BY created_at DESC LIMIT 1), 'paid'
  )$$,
  '55000',
  'payouts cannot skip the required approval state'
);
SELECT public.set_payout_status(
  (SELECT id FROM public.payout_entries
   WHERE task_type = 'manual' ORDER BY created_at DESC LIMIT 1), 'approved'
);
SELECT public.set_payout_status(
  (SELECT id FROM public.payout_entries
   WHERE task_type = 'manual' ORDER BY created_at DESC LIMIT 1), 'paid'
);
SELECT test.expect_sqlstate(
  $$SELECT public.set_payout_status(
    (SELECT id FROM public.payout_entries
     WHERE task_type = 'manual' ORDER BY created_at DESC LIMIT 1), 'void'
  )$$,
  '55000',
  'paid historical payouts are terminal and immutable'
);
SELECT test.assert_true(
  (SELECT status = 'paid' AND rule_snapshot->>'reason' = 'Documented reshoot deduction'
   FROM public.payout_entries WHERE task_type = 'manual'
   ORDER BY created_at DESC LIMIT 1),
  'manual payout adjustments preserve their reason and controlled lifecycle'
);

UPDATE public.vehicles SET comments = 'Updated after document generation'
WHERE id = '10000000-0000-0000-0000-000000000001';
SELECT test.assert_true(
  EXISTS (SELECT 1 FROM public.generated_documents
          WHERE vehicle_id = '10000000-0000-0000-0000-000000000001'
            AND stale_at IS NOT NULL),
  'vehicle changes visibly mark prior generated-document versions stale'
);
SELECT test.assert_true(
  (SELECT count(*) >= 7 FROM public.audit_events
   WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND event_type IN (
       'configuration.readiness_changed','vehicle_media.primary_changed',
       'vehicle_media.order_changed','payout.manual_adjustment_created',
       'payout.status_changed'
     )),
  'settings, media ordering, and payout transitions emit durable audit events'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
INSERT INTO public.dealerships (id, name, status, subscription_status)
VALUES ('eeeeeeee-0000-0000-0000-000000000001', 'New Store', 'active', 'active');
SELECT test.assert_true(
  (SELECT organization_id = id FROM public.dealerships
   WHERE id = 'eeeeeeee-0000-0000-0000-000000000001')
  AND (SELECT count(*) = 7 FROM public.media_processing_rules
       WHERE dealership_id = 'eeeeeeee-0000-0000-0000-000000000001')
  AND (SELECT count(*) = 14 FROM public.readiness_rules
       WHERE dealership_id = 'eeeeeeee-0000-0000-0000-000000000001')
  AND (SELECT count(*) = 5 FROM public.document_templates
       WHERE dealership_id = 'eeeeeeee-0000-0000-0000-000000000001')
  AND (SELECT completion_policy = 'warn' FROM public.photography_settings
       WHERE dealership_id = 'eeeeeeee-0000-0000-0000-000000000001')
  AND (SELECT count(*) = 13 FROM public.photo_shot_requirements
       WHERE dealership_id = 'eeeeeeee-0000-0000-0000-000000000001'),
  'new dealerships receive an organization and operational defaults atomically'
);
RESET ROLE;

SELECT test.assert_true(
  (
    SELECT bool_and(array_to_string(p.proconfig, ',') = 'search_path=""')
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE p.prosecdef
      AND n.nspname IN ('private', 'public')
  ),
  'every authorization SECURITY DEFINER function fixes search_path'
);
SELECT test.assert_true(
  (
    SELECT count(*) = 49
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'profiles', 'dealerships', 'vehicles', 'photos', 'overlay_templates',
        'documents', 'vehicle_documents', 'backdrops', 'impersonation_logs',
        'user_invitations', 'photo_capture_sessions', 'bulk_photo_items',
        'photography_settings', 'photo_shot_requirements',
        'media_assets', 'media_variants'
      )
  ),
  'repository tables have only the reviewed policy set'
);
SELECT test.assert_true(
  (
    SELECT count(*) = 17
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
  ),
  'Storage has only the reviewed public-asset and private-media policies'
);

-- Phase 1 settings remain readable only through active tenant scope, and all
-- writes are audited server-side.
-- An uncertain provider result also fails closed without claiming that the
-- password reset completed. This runs after the ordinary Staff A assertions.
SET ROLE service_role;
SELECT public.begin_temporary_password_reset_operation(
  '00000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-00000000000f',
  '00000000-0000-0000-0000-000000000003'
);
SELECT public.contain_temporary_password_reset_operation(
  '00000000-0000-0000-0000-000000000001',
  (SELECT id FROM public.user_account_operations
   WHERE idempotency_key = '90000000-0000-0000-0000-00000000000f'),
  'transport_uncertain'
);
SELECT test.assert_true(
  (SELECT status = 'needs_reconciliation' AND safe_error_code = 'transport_uncertain'
   FROM public.user_account_operations
   WHERE idempotency_key = '90000000-0000-0000-0000-00000000000f'),
  'uncertain reset is durable and requires reconciliation'
);
RESET ROLE;
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT test.assert_true((SELECT count(*) = 0 FROM public.vehicles), 'uncertain reset immediately contains the active session');
RESET ROLE;

SET ROLE service_role;
SELECT public.admin_set_platform_setting(
  '00000000-0000-0000-0000-000000000001', 'platform.locale', '{"default":"en-US"}'::jsonb
);
SELECT public.admin_set_dealership_setting(
  '00000000-0000-0000-0000-000000000002',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'workflow.replacement_credit_policy', '{"review":true}'::jsonb
);
SELECT public.admin_set_dealership_setting(
  '00000000-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'staff.self_pay_visibility', '{"enabled":false}'::jsonb, 'active_members'
);
SELECT test.expect_sqlstate(
  $$SELECT public.admin_set_dealership_setting(
    '00000000-0000-0000-0000-000000000002',
    'aaaaaaaa-0000-0000-0000-000000000001', 'platform.sensitive', '{}'::jsonb)$$,
  'P0001',
  'dealer administrator cannot write non-allowlisted settings'
);
SELECT test.expect_sqlstate(
  $$SELECT public.admin_set_dealership_setting(
    '00000000-0000-0000-0000-000000000002',
    'cccccccc-0000-0000-0000-000000000001', 'dealer.workflow', '{}'::jsonb)$$,
  'P0001',
  'dealer administrator cannot write a suspended or unassigned dealership setting'
);
SELECT test.assert_true(
  (SELECT count(*) = 3 FROM public.audit_events
   WHERE event_type IN ('setting.platform_updated', 'setting.dealership_updated')),
  'setting mutations emit durable audit events'
);
SELECT test.expect_sqlstate(
  $$DELETE FROM public.audit_events WHERE event_type = 'setting.platform_updated'$$,
  '55000',
  'audit events are append-only even for the service role'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
SELECT test.assert_true((SELECT count(*) = 1 FROM public.platform_settings), 'active owner reads platform settings');
RESET ROLE;
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000004';
SELECT test.assert_true((SELECT count(*) = 0 FROM public.platform_settings), 'staff cannot read platform settings');
SELECT test.assert_true(
  (SELECT count(*) = 1 FROM public.dealership_settings
   WHERE dealership_id = 'bbbbbbbb-0000-0000-0000-000000000001'
     AND read_scope = 'active_members'),
  'staff reads only explicitly member-visible settings in its own tenant'
);
RESET ROLE;

SELECT test.assert_true(
  NOT has_table_privilege('authenticated', 'private.background_jobs', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'private.background_jobs', 'INSERT')
  AND NOT has_function_privilege('authenticated', 'public.enqueue_background_job(text,jsonb,uuid,text,uuid,integer,smallint,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.worker_claim_background_job(text,integer)', 'EXECUTE'),
  'ordinary users cannot inspect, enqueue, or claim private jobs'
);

-- Queue lifecycle: dedupe, claim, retry with backoff, reclaim, complete, and
-- terminal failure all use service-only RPCs and durable attempt records.
DELETE FROM private.background_jobs
WHERE job_type LIKE 'media.%' OR job_type = 'vehicle.storage.cleanup';
SET ROLE service_role;
SELECT (public.enqueue_background_job(
  'system.noop', '{"source":"portable-test"}'::jsonb,
  'aaaaaaaa-0000-0000-0000-000000000001', 'portable-dedupe',
  '91000000-0000-0000-0000-000000000001', 3, 10::smallint,
  '00000000-0000-0000-0000-000000000001'
)->>'job_id') AS queue_job_id \gset
SELECT (public.enqueue_background_job(
  'system.noop', '{"source":"portable-test"}'::jsonb,
  'aaaaaaaa-0000-0000-0000-000000000001', 'portable-dedupe'
)->>'job_id') AS duplicate_job_id \gset
SELECT test.assert_true(:'queue_job_id' = :'duplicate_job_id', 'job enqueue deduplicates the same workload');

SELECT (public.worker_claim_background_job('portable-worker', 60)->>'job_id') AS claimed_job_id \gset
SELECT test.assert_true(:'claimed_job_id' = :'queue_job_id', 'worker atomically claims the ready job');
SELECT test.assert_true(
  public.worker_heartbeat_background_job('portable-worker', :'queue_job_id'::uuid, 60),
  'worker can extend its own lease'
);
SELECT test.assert_true(
  public.worker_fail_background_job('portable-worker', :'queue_job_id'::uuid, 'transient_test', true) = 'retry_scheduled',
  'retryable failure schedules bounded retry'
);
RESET ROLE;
UPDATE private.background_jobs SET available_at = now() WHERE id = :'queue_job_id'::uuid;
SET ROLE service_role;
SELECT (public.worker_claim_background_job('portable-worker-2', 60)->>'job_id') AS reclaimed_job_id \gset
SELECT test.assert_true(:'reclaimed_job_id' = :'queue_job_id', 'scheduled retry can be claimed again');
SELECT test.assert_true(
  public.worker_complete_background_job('portable-worker-2', :'queue_job_id'::uuid, '{"ok":true}'::jsonb),
  'worker completes its leased job'
);
RESET ROLE;
SELECT test.assert_true(
  (SELECT attempt_count = 2 AND status = 'succeeded' FROM private.background_jobs WHERE id = :'queue_job_id'::uuid)
  AND (SELECT count(*) = 2 FROM private.background_job_attempts WHERE job_id = :'queue_job_id'::uuid),
  'job and attempt history retain the complete lifecycle'
);

SET ROLE service_role;
SELECT (public.enqueue_background_job(
  'system.noop', '{}'::jsonb, NULL, 'portable-terminal',
  '91000000-0000-0000-0000-000000000002', 1
)->>'job_id') AS terminal_job_id \gset
SELECT public.worker_claim_background_job('portable-worker', 60);
SELECT test.assert_true(
  public.worker_fail_background_job('portable-worker', :'terminal_job_id'::uuid, 'permanent_test', false) = 'dead_letter',
  'non-retryable failure is dead-lettered'
);
SELECT test.assert_true(
  ((public.worker_get_queue_metrics()->>'dead_letter')::integer = 1),
  'queue metrics expose the terminal backlog without job payloads'
);
RESET ROLE;

SET ROLE anon;
SELECT test.assert_true(
  (SELECT count(*) = 0 FROM storage.objects WHERE bucket_id = 'vehicle-photos'),
  'anonymous users cannot read private vehicle originals'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('vehicle-photos', '10000000-0000-0000-0000-000000000001/anon.jpg')$$,
  '42501',
  'anonymous users cannot mutate Storage objects'
);
RESET ROLE;

-- Audit subject identifiers survive account erasure without mutating the
-- append-only audit row.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (
  '00000000-0000-0000-0000-000000000099',
  'audit-erasure@example.test',
  '{"full_name":"Audit Erasure Fixture"}'::jsonb
);
INSERT INTO public.audit_events (
  event_type,
  actor_profile_id,
  target_profile_id,
  payload
) VALUES (
  'user.erasure_fixture',
  '00000000-0000-0000-0000-000000000099',
  '00000000-0000-0000-0000-000000000099',
  '{}'::jsonb
);
DELETE FROM auth.users
WHERE id = '00000000-0000-0000-0000-000000000099';
SELECT test.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = '00000000-0000-0000-0000-000000000099'
  )
  AND EXISTS (
    SELECT 1 FROM public.audit_events
    WHERE event_type = 'user.erasure_fixture'
      AND actor_profile_id = '00000000-0000-0000-0000-000000000099'
      AND target_profile_id = '00000000-0000-0000-0000-000000000099'
  ),
  'account erasure preserves immutable audit subject identifiers'
);

-- Vehicle deletion is a privileged, idempotent workflow rather than a raw
-- table delete. It preserves production history and writes a durable exact
-- Storage cleanup outbox.
SELECT test.assert_true(
  NOT has_table_privilege('authenticated', 'public.vehicles', 'DELETE')
  AND has_function_privilege('authenticated', 'public.delete_vehicle(uuid)', 'EXECUTE')
  AND NOT has_table_privilege('authenticated', 'private.vehicle_deletion_operations', 'SELECT')
  AND NOT has_function_privilege('authenticated', 'public.worker_get_vehicle_deletion_operation(uuid)', 'EXECUTE'),
  'vehicle deletion exposes only the authorized workflow to ordinary users'
);

INSERT INTO public.vehicles (id, dealership_id, vin, make, model, stock_number) VALUES
  ('10000000-0000-4000-8000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', 'DELETE-NO-MEDIA', 'Delete', 'Empty', 'DEL-EMPTY'),
  ('10000000-0000-4000-8000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', 'DELETE-WITH-MEDIA', 'Delete', 'Media', 'DEL-MEDIA'),
  ('10000000-0000-4000-8000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', 'DELETE-ACTIVE', 'Delete', 'Active', 'DEL-ACTIVE'),
  ('10000000-0000-4000-8000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000001', 'DELETE-HISTORY', 'Delete', 'History', 'DEL-HISTORY'),
  ('10000000-0000-4000-8000-000000000014', 'bbbbbbbb-0000-0000-0000-000000000001', 'DELETE-OTHER', 'Delete', 'Other', 'DEL-OTHER');

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT test.expect_sqlstate(
  $$SELECT public.delete_vehicle('10000000-0000-4000-8000-000000000010')$$,
  '42501',
  'photographers cannot permanently delete vehicles'
);
SELECT test.expect_sqlstate(
  $$SELECT public.delete_vehicle('10000000-0000-4000-8000-000000000014')$$,
  '42501',
  'an unauthorized store identity cannot delete a cross-store vehicle'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
SELECT (public.delete_vehicle('10000000-0000-4000-8000-000000000010')->>'operation_id') AS empty_delete_operation \gset
SELECT (public.delete_vehicle('10000000-0000-4000-8000-000000000010')->>'status') AS empty_second_delete_status \gset
RESET ROLE;
SELECT test.assert_true(
  NOT EXISTS (SELECT 1 FROM public.vehicles WHERE id = '10000000-0000-4000-8000-000000000010')
  AND EXISTS (
    SELECT 1 FROM private.vehicle_deletion_operations
    WHERE id = :'empty_delete_operation'::uuid
      AND storage_manifest = '[]'::jsonb
      AND storage_status = 'queued'
  ),
  'a dependency-free vehicle deletes through the controlled workflow'
);
SELECT test.assert_true(
  :'empty_second_delete_status' = 'already_deleted'
  AND (
    SELECT count(*) = 1 FROM public.audit_events
    WHERE event_type = 'vehicle.deleted'
      AND payload->>'operation_id' = :'empty_delete_operation'
  ),
  'double deletion is idempotent and does not duplicate the audit event'
);

INSERT INTO public.media_assets (
  id, organization_id, dealership_id, vehicle_id, uploaded_by,
  source_type, content_type, byte_size, checksum_sha256,
  storage_bucket, storage_object_path
) VALUES (
  '80000000-0000-4000-8000-000000000011',
  '11111111-aaaa-4000-8000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001',
  '10000000-0000-4000-8000-000000000011',
  '00000000-0000-0000-0000-000000000001',
  'capture', 'image/jpeg', 100,
  repeat('a', 64), 'dealer-media-private',
  'stores/aaaaaaaa-0000-0000-0000-000000000001/vehicles/10000000-0000-4000-8000-000000000011/media/80000000-0000-4000-8000-000000000011/original/source.jpg'
);
INSERT INTO public.photos (id, vehicle_id, media_asset_id, image_url, original_image_url)
VALUES (
  '30000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000011',
  '80000000-0000-4000-8000-000000000011',
  'private-media:80000000-0000-4000-8000-000000000011',
  'private-media:80000000-0000-4000-8000-000000000011'
);
UPDATE public.media_variants
SET storage_bucket = 'dealer-media-private',
    storage_path = 'stores/aaaaaaaa-0000-0000-0000-000000000001/vehicles/10000000-0000-4000-8000-000000000011/media/80000000-0000-4000-8000-000000000011/original/source.jpg',
    content_type = 'image/jpeg', byte_size = 100, checksum = repeat('a', 64)
WHERE media_asset_id = '80000000-0000-4000-8000-000000000011';
INSERT INTO public.media_variants (
  id, photo_id, media_asset_id, source_variant_id, variant_type, variant_role,
  image_url, processing_status, storage_bucket, storage_path,
  content_type, byte_size, checksum
)
SELECT
  '81000000-0000-4000-8000-000000000011', photo.id, photo.media_asset_id,
  original.id, 'thumbnail', 'thumbnail_small',
  'private-media:80000000-0000-4000-8000-000000000011', 'completed',
  'dealer-media-private',
  'stores/aaaaaaaa-0000-0000-0000-000000000001/vehicles/10000000-0000-4000-8000-000000000011/media/80000000-0000-4000-8000-000000000011/derivatives/thumbnail-320.webp',
  'image/webp', 50, repeat('b', 64)
FROM public.photos AS photo
JOIN public.media_variants AS original
  ON original.media_asset_id = photo.media_asset_id AND original.variant_type = 'original'
WHERE photo.id = '30000000-0000-4000-8000-000000000011';
INSERT INTO private.background_jobs (
  id, job_type, payload, dealership_id, resource_type, resource_id, status, dedupe_key
) VALUES (
  '82000000-0000-4000-8000-000000000011', 'media.thumbnail.generate',
  '{"media_asset_id":"80000000-0000-4000-8000-000000000011"}',
  'aaaaaaaa-0000-0000-0000-000000000001', 'media_asset',
  '80000000-0000-4000-8000-000000000011', 'queued', 'delete-media-fixture'
);

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
SELECT (public.delete_vehicle('10000000-0000-4000-8000-000000000011')->>'operation_id') AS media_delete_operation \gset
RESET ROLE;
SELECT test.assert_true(
  NOT EXISTS (SELECT 1 FROM public.photos WHERE id = '30000000-0000-4000-8000-000000000011')
  AND NOT EXISTS (SELECT 1 FROM public.media_assets WHERE id = '80000000-0000-4000-8000-000000000011')
  AND NOT EXISTS (SELECT 1 FROM public.media_variants WHERE media_asset_id = '80000000-0000-4000-8000-000000000011')
  AND (SELECT status = 'cancelled' FROM private.background_jobs WHERE id = '82000000-0000-4000-8000-000000000011')
  AND (
    SELECT jsonb_array_length(storage_manifest) = 2
    FROM private.vehicle_deletion_operations
    WHERE id = :'media_delete_operation'::uuid
  ),
  'vehicle media, variants, and queued jobs are handled without FK violations'
);

INSERT INTO public.photo_capture_sessions (
  id, dealership_id, vehicle_id, mode, status, created_by, started_at
) VALUES (
  '83000000-0000-4000-8000-000000000012',
  'aaaaaaaa-0000-0000-0000-000000000001',
  '10000000-0000-4000-8000-000000000012',
  'guided', 'in_progress', '00000000-0000-0000-0000-000000000003', now()
);
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
SELECT test.expect_sqlstate(
  $$SELECT public.delete_vehicle('10000000-0000-4000-8000-000000000012')$$,
  '55000',
  'active capture blocks vehicle deletion without partial changes'
);
RESET ROLE;
SELECT test.assert_true(
  EXISTS (SELECT 1 FROM public.vehicles WHERE id = '10000000-0000-4000-8000-000000000012')
  AND EXISTS (SELECT 1 FROM public.photo_capture_sessions WHERE id = '83000000-0000-4000-8000-000000000012'),
  'blocked active-capture deletion rolls back completely'
);

UPDATE public.photo_capture_sessions
SET completion_policy = 'warn', status = 'completed', completed_by = created_by, completed_at = now(),
    photo_count = 1, duration_seconds = 60
WHERE id = '83000000-0000-4000-8000-000000000012';
INSERT INTO public.payout_entries (
  id, dealership_id, organization_id, employee_id, vehicle_id, photo_shoot_id,
  task_type, work_date, amount, rule_snapshot, status,
  approved_by, approved_at, paid_by, paid_at
) VALUES (
  '84000000-0000-4000-8000-000000000012',
  'aaaaaaaa-0000-0000-0000-000000000001',
  '11111111-aaaa-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000003',
  '10000000-0000-4000-8000-000000000012',
  '83000000-0000-4000-8000-000000000012',
  'photo_shoot', current_date, 25.00, '{"version":1}', 'paid',
  '00000000-0000-0000-0000-000000000002', now(),
  '00000000-0000-0000-0000-000000000002', now()
);
INSERT INTO public.generated_documents (
  id, vehicle_id, organization_id, dealership_id, document_type,
  template_version, vehicle_snapshot, generated_by
) VALUES (
  '86000000-0000-4000-8000-000000000012',
  '10000000-0000-4000-8000-000000000012',
  '11111111-aaaa-4000-8000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'window_sticker', 1, '{"stock_number":"DEL-ACTIVE"}',
  '00000000-0000-0000-0000-000000000001'
);
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
SELECT public.delete_vehicle('10000000-0000-4000-8000-000000000012');
RESET ROLE;
SELECT test.assert_true(
  (SELECT vehicle_id IS NULL AND status = 'completed'
   FROM public.photo_capture_sessions WHERE id = '83000000-0000-4000-8000-000000000012')
  AND (SELECT vehicle_id IS NULL AND amount = 25.00 AND status = 'paid'
       AND vehicle_snapshot->>'stock_number' = 'DEL-ACTIVE'
       FROM public.payout_entries WHERE id = '84000000-0000-4000-8000-000000000012')
  AND NOT EXISTS (
    SELECT 1 FROM public.generated_documents
    WHERE id = '86000000-0000-4000-8000-000000000012'
  ),
  'completed capture and paid payout history survive while vehicle documents are removed'
);

INSERT INTO private.background_jobs (
  id, job_type, payload, dealership_id, resource_type, resource_id, status,
  lease_owner, lease_expires_at, dedupe_key
) VALUES (
  '85000000-0000-4000-8000-000000000013', 'media.thumbnail.generate',
  '{"vehicle_id":"10000000-0000-4000-8000-000000000013"}',
  'aaaaaaaa-0000-0000-0000-000000000001', 'vehicle',
  '10000000-0000-4000-8000-000000000013', 'running',
  'portable-worker', now() + interval '1 minute', 'delete-running-fixture'
);
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
SELECT test.expect_sqlstate(
  $$SELECT public.delete_vehicle('10000000-0000-4000-8000-000000000013')$$,
  '55000',
  'running processing blocks vehicle deletion'
);
RESET ROLE;
SELECT test.assert_true(
  EXISTS (SELECT 1 FROM public.vehicles WHERE id = '10000000-0000-4000-8000-000000000013'),
  'running-job rejection leaves the vehicle intact'
);

-- Bulk-first store settings and route enforcement remain capability and tenant scoped.
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
SELECT public.save_capture_method_configuration(
  'aaaaaaaa-0000-0000-0000-000000000001', true, false, 'bulk'
);
SELECT test.assert_true(
  public.get_capture_method_configuration(
    'aaaaaaaa-0000-0000-0000-000000000001'
  ) @> '{"bulk_enabled":true,"guided_enabled":false,"default_method":"bulk"}'::jsonb,
  'authorized administrator configures Bulk as the only enabled default'
);
SELECT test.expect_sqlstate(
  $$SELECT public.save_capture_method_configuration(
      'aaaaaaaa-0000-0000-0000-000000000001', false, false, 'bulk'
    )$$,
  '22023',
  'capture configuration cannot disable every method'
);
RESET ROLE;

SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT test.expect_sqlstate(
  $$SELECT public.save_capture_method_configuration(
      'aaaaaaaa-0000-0000-0000-000000000001', true, true, 'bulk'
    )$$,
  '42501',
  'capture staff cannot change store capture settings'
);
SELECT test.expect_sqlstate(
  $$SELECT public.start_photo_capture_session(
      'aaaaaaaa-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001', NULL, 'guided'
    )$$,
  '42501',
  'a disabled Guided method is rejected by the capture RPC'
);
RESET ROLE;
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
SELECT public.start_photo_capture_session(
  'aaaaaaaa-0000-0000-0000-000000000001',
  NULL, '1HGCM82633A004352', 'bulk'
);
SELECT test.assert_true(
  EXISTS (
    SELECT 1 FROM public.photo_capture_sessions
    WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND vehicle_id IS NULL AND vin = '1HGCM82633A004352'
      AND created_by = '00000000-0000-0000-0000-000000000002'
      AND mode = 'bulk' AND status = 'in_progress'
  ),
  'authorized store user can start the enabled Bulk method'
);
SELECT test.assert_true(
  (public.start_photo_capture_session(
    'aaaaaaaa-0000-0000-0000-000000000001',
    NULL, '1HGCM82633A004352', 'bulk'
  )).id = (
    SELECT id FROM public.photo_capture_sessions
    WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND vin = '1HGCM82633A004352' AND mode = 'bulk' AND status = 'in_progress'
  )
  AND (
    SELECT count(*) = 1 FROM public.photo_capture_sessions
    WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND vin = '1HGCM82633A004352' AND mode = 'bulk' AND status = 'in_progress'
  ),
  'repeated Bulk start returns the one existing active workflow'
);
RESET ROLE;
SET "request.jwt.claim.sub" = '';
SET ROLE service_role;
SELECT public.finalize_private_bulk_upload(
  '00000000-0000-0000-0000-000000000002',
  'fa000000-0000-4000-8000-000000000001',
  (
    SELECT id FROM public.photo_capture_sessions
    WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND vin = '1HGCM82633A004352' AND mode = 'bulk' AND status = 'in_progress'
  ),
  'dealer-media-private',
  'stores/aaaaaaaa-0000-0000-0000-000000000001/sessions/' || (
    SELECT id FROM public.photo_capture_sessions
    WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND vin = '1HGCM82633A004352' AND mode = 'bulk' AND status = 'in_progress'
  ) || '/media/fa000000-0000-4000-8000-000000000001/original/test.jpg',
  'test.jpg', 'image/jpeg', 1024, 1920, 1080,
  repeat('a', 64), 0
);
SELECT test.assert_true(
  EXISTS (
    SELECT 1 FROM public.bulk_photo_items
    WHERE media_asset_id = 'fa000000-0000-4000-8000-000000000001'
      AND created_by = '00000000-0000-0000-0000-000000000002'
  )
  AND EXISTS (
    SELECT 1 FROM public.media_variants
    WHERE media_asset_id = 'fa000000-0000-4000-8000-000000000001'
      AND variant_type = 'original'
  ),
  'trusted server finalizes authorized Bulk media while preserving actor attribution'
);
RESET ROLE;
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000003';
SELECT test.expect_sqlstate(
  $$SELECT public.start_photo_capture_session(
      'bbbbbbbb-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002', NULL, 'bulk'
    )$$,
  '42501',
  'capture staff cannot start Bulk in another store'
);
RESET ROLE;
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000004';
SELECT test.expect_sqlstate(
  $$SELECT public.cancel_bulk_capture_workflow((
      SELECT id FROM public.photo_capture_sessions
      WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
        AND vin = '1HGCM82633A004352' AND mode = 'bulk' AND status = 'in_progress'
    ))$$,
  '42501',
  'cross-store staff cannot cancel another store Bulk workflow'
);
RESET ROLE;
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
SELECT public.cancel_bulk_capture_workflow((
  SELECT id FROM public.photo_capture_sessions
  WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    AND vin = '1HGCM82633A004352' AND mode = 'bulk' AND status = 'in_progress'
));
SELECT test.assert_true(
  (SELECT count(*) = 1 AND bool_and(canceled_at IS NOT NULL)
   FROM public.photo_capture_sessions
   WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND vin = '1HGCM82633A004352' AND mode = 'bulk' AND status = 'canceled')
  AND NOT EXISTS (
    SELECT 1 FROM public.payout_entries AS payout
    JOIN public.photo_capture_sessions AS session ON session.id = payout.photo_shoot_id
    WHERE session.dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND session.vin = '1HGCM82633A004352' AND session.status = 'canceled'
  )
  AND (SELECT count(*) = 1 FROM public.audit_events
       WHERE event_type = 'bulk_photo_session.canceled'
         AND payload->>'vin' = '1HGCM82633A004352'),
  'cancel stops the timer, records one audit event, and creates no payout'
);
SELECT test.assert_true(
  (public.cancel_bulk_capture_workflow((
    SELECT id FROM public.photo_capture_sessions
    WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND vin = '1HGCM82633A004352' AND mode = 'bulk' AND status = 'canceled'
  ))).status = 'canceled'
  AND (SELECT count(*) = 1 FROM public.audit_events
       WHERE event_type = 'bulk_photo_session.canceled'
         AND payload->>'vin' = '1HGCM82633A004352'),
  'double cancel is idempotent and does not duplicate audit history'
);
SELECT public.start_photo_capture_session(
  'aaaaaaaa-0000-0000-0000-000000000001',
  NULL, '1HGCM82633A004352', 'bulk'
);
SELECT test.assert_true(
  (SELECT count(*) = 1 FROM public.photo_capture_sessions
   WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND vin = '1HGCM82633A004352' AND mode = 'bulk' AND status = 'in_progress')
  AND (SELECT count(*) = 1 FROM public.photo_capture_sessions
       WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
         AND vin = '1HGCM82633A004352' AND mode = 'bulk' AND status = 'canceled'),
  'a canceled workflow does not block one future Bulk capture'
);
RESET ROLE;
DELETE FROM private.background_jobs
WHERE resource_type = 'media_asset'
  AND resource_id = 'fa000000-0000-4000-8000-000000000001';
DELETE FROM public.bulk_photo_items
WHERE media_asset_id = 'fa000000-0000-4000-8000-000000000001';
DELETE FROM public.media_variants
WHERE media_asset_id = 'fa000000-0000-4000-8000-000000000001';
DELETE FROM public.media_assets
WHERE id = 'fa000000-0000-4000-8000-000000000001';
DELETE FROM public.photo_capture_sessions
WHERE dealership_id = 'aaaaaaaa-0000-0000-0000-000000000001'
  AND vehicle_id IS NULL AND vin = '1HGCM82633A004352'
  AND created_by = '00000000-0000-0000-0000-000000000002'
  AND mode = 'bulk';
SET ROLE authenticated;
SET "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
SELECT public.save_capture_method_configuration(
  'aaaaaaaa-0000-0000-0000-000000000001', true, true, 'bulk'
);
RESET ROLE;

SELECT test.assert_true(
  NOT has_function_privilege(
    'anon',
    'public.worker_commit_vehicle_aware_cutout(uuid,uuid,text,text,bigint,integer,integer,text,text,numeric,jsonb)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.worker_commit_vehicle_aware_cutout(uuid,uuid,text,text,bigint,integer,integer,text,text,numeric,jsonb)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.worker_commit_vehicle_aware_cutout(uuid,uuid,text,text,bigint,integer,integer,text,text,numeric,jsonb)',
    'EXECUTE'
  ),
  'vehicle-aware cutout finalization is service-only and cannot be called cross-store by browser roles'
);

DROP SCHEMA test CASCADE;

\echo 'DealerShot portable authorization assertions passed.'
