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

INSERT INTO public.dealerships (id, name, status, subscription_status) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Dealer A', 'active', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Dealer B', 'active', 'active'),
  ('cccccccc-0000-0000-0000-000000000001', 'Suspended Dealer', 'suspended', 'active'),
  ('dddddddd-0000-0000-0000-000000000001', 'Inactive Subscription', 'active', 'past_due');

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
        'user_invitations', 'profile_dealerships', 'objects'
      )
      AND r.rolname = 'authenticated'
  ),
  'authenticated does not own protected tables'
);
SELECT test.assert_true(
  (
    SELECT count(*) = 12
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'storage')
      AND c.relname IN (
        'profiles', 'dealerships', 'vehicles', 'photos', 'overlay_templates',
        'documents', 'vehicle_documents', 'backdrops', 'impersonation_logs',
        'user_invitations', 'profile_dealerships', 'objects'
      )
      AND c.relrowsecurity
  ),
  'RLS is enabled on every protected table'
);

SET ROLE authenticated;
SELECT test.assert_true(current_user = 'authenticated', 'ordinary assertions run as authenticated');
SELECT test.assert_true(current_setting('row_security') = 'on', 'row_security is on for ordinary assertions');
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
SELECT test.assert_row_count(
  $$DELETE FROM public.vehicles WHERE id = '10000000-0000-0000-0000-000000000002'$$,
  0,
  'staff A cannot delete a dealer B vehicle'
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
SELECT test.assert_row_count(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('vehicle-photos', '10000000-0000-0000-0000-000000000001/staff-a.jpg')$$,
  1,
  'staff A can upload to a dealer A vehicle path'
);
SELECT test.assert_row_count(
  $$UPDATE storage.objects SET name = '10000000-0000-0000-0000-000000000001/staff-a-renamed.jpg' WHERE bucket_id = 'vehicle-photos' AND name = '10000000-0000-0000-0000-000000000001/staff-a.jpg'$$,
  1,
  'staff A can update an authorized Storage object'
);
SELECT test.expect_sqlstate(
  $$UPDATE storage.objects SET name = '10000000-0000-0000-0000-000000000002/moved.jpg' WHERE bucket_id = 'vehicle-photos' AND name = '10000000-0000-0000-0000-000000000001/staff-a-renamed.jpg'$$,
  '42501',
  'Storage UPDATE WITH CHECK prevents a cross-tenant move'
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
  1,
  'staff A can delete their authorized Storage object'
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
SELECT test.assert_row_count(
  $$DELETE FROM public.vehicles WHERE id = '10000000-0000-0000-0000-000000000010'$$,
  1,
  'dealer administrator can delete a vehicle in their dealership'
);
SELECT test.assert_row_count(
  $$INSERT INTO public.vehicles (id, dealership_id, make) VALUES ('10000000-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001', 'Second assigned dealer')$$,
  1,
  'dealer administrator can create tenant data in a second assigned dealership'
);
SELECT test.assert_row_count(
  $$DELETE FROM public.vehicles WHERE id = '10000000-0000-0000-0000-000000000011'$$,
  1,
  'dealer administrator can administer a second assigned dealership'
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
SELECT test.assert_true(
  (
    SELECT bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') = 'search_path=""')
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE (n.nspname = 'private')
       OR (
         n.nspname = 'public'
         AND p.proname IN (
           'handle_new_user', 'get_invitation_details',
            'check_invitation_account_exists', 'accept_invitation',
            'admin_update_user_account_access'
         )
       )
  ),
  'every authorization SECURITY DEFINER function fixes search_path'
);
SELECT test.assert_true(
  (
    SELECT count(*) = 39
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'profiles', 'dealerships', 'vehicles', 'photos', 'overlay_templates',
        'documents', 'vehicle_documents', 'backdrops', 'impersonation_logs',
        'user_invitations'
      )
  ),
  'repository tables have only the reviewed policy set'
);
SELECT test.assert_true(
  (
    SELECT count(*) = 20
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
  ),
  'Storage has only the reviewed public-read and active-mutation policies'
);

SET ROLE anon;
SELECT test.assert_true(
  (SELECT count(*) >= 1 FROM storage.objects WHERE bucket_id = 'vehicle-photos'),
  'anonymous public Storage reads remain available'
);
SELECT test.expect_sqlstate(
  $$INSERT INTO storage.objects (bucket_id, name) VALUES ('vehicle-photos', '10000000-0000-0000-0000-000000000001/anon.jpg')$$,
  '42501',
  'anonymous users cannot mutate Storage objects'
);
RESET ROLE;

DROP SCHEMA test CASCADE;

\echo 'DealerShot portable authorization assertions passed.'
