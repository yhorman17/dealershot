-- DealerShot authorization containment.
--
-- Security model:
--   * active platform owners can administer every dealership;
--   * active dealer_admin/staff users can access only their active dealership;
--   * a dealership is usable when status is active/trial and its subscription
--     status is active;
--   * deactivated profiles and suspended/inactive dealerships are denied by
--     database and Storage write policies even while an Auth JWT remains valid;
--   * browser clients may update only profiles.full_name directly.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;

-- Permissive policies combine with OR. Refuse to continue if the target has
-- policy drift that this migration has not been reviewed to replace.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'profiles', 'dealerships', 'vehicles', 'photos', 'overlay_templates',
        'documents', 'vehicle_documents', 'backdrops', 'impersonation_logs',
        'user_invitations'
      )
      AND policyname <> ALL (ARRAY[
        'Users can view own profile',
        'Users can update own profile',
        'Owners can insert profiles',
        'Owners can delete profiles',
        'View own dealership',
        'Owners manage dealerships - insert',
        'Owners manage dealerships - update',
        'Owners manage dealerships - delete',
        'View vehicles in dealership',
        'Insert vehicles in dealership',
        'Update vehicles in dealership',
        'Delete vehicles in dealership',
        'View photos in dealership',
        'Insert photos in dealership',
        'Update photos in dealership',
        'Delete photos in dealership',
        'View overlays in dealership',
        'Insert overlays in dealership',
        'Update overlays in dealership',
        'Delete overlays in dealership',
        'View documents in dealership',
        'Insert documents in dealership',
        'Update documents in dealership',
        'Delete documents in dealership',
        'View vehicle_documents in dealership',
        'Insert vehicle_documents in dealership',
        'Update vehicle_documents in dealership',
        'Delete vehicle_documents in dealership',
        'View backdrops in dealership',
        'Insert backdrops in dealership',
        'Update backdrops in dealership',
        'Delete backdrops in dealership',
        'Owners can view impersonation logs',
        'Owners can insert impersonation logs',
        'Owners can update impersonation logs',
        'Owners view invitations',
        'Owners insert invitations',
        'Owners update invitations',
        'Owners delete invitations'
      ])
  ) THEN
    RAISE EXCEPTION 'Unexpected public-table RLS policy drift; review before applying authorization containment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname <> ALL (ARRAY[
        'Public read vehicle photos',
        'Public read overlays',
        'Public read backdrops',
        'Public read dealership logos',
        'Read documents in own dealership',
        'Insert vehicle photos in own dealership',
        'Update vehicle photos in own dealership',
        'Delete vehicle photos in own dealership',
        'Insert overlays in own dealership',
        'Update overlays in own dealership',
        'Delete overlays in own dealership',
        'Insert backdrops in own dealership',
        'Update backdrops in own dealership',
        'Delete backdrops in own dealership',
        'Insert documents in own dealership',
        'Update documents in own dealership',
        'Delete documents in own dealership',
        'Owners insert dealership logos',
        'Owners update dealership logos',
        'Owners delete dealership logos'
      ])
  ) THEN
    RAISE EXCEPTION 'Unexpected Storage RLS policy drift; review before applying authorization containment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE status NOT IN ('active', 'deactivated')
  ) THEN
    RAISE EXCEPTION 'Unsupported profile status values must be reconciled before applying authorization containment';
  END IF;
END
$$;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_status_check
  CHECK (status IN ('active', 'deactivated'));

CREATE INDEX profiles_dealership_id_idx
  ON public.profiles (dealership_id);
CREATE INDEX vehicles_dealership_id_idx
  ON public.vehicles (dealership_id);
CREATE INDEX overlay_templates_dealership_id_idx
  ON public.overlay_templates (dealership_id);
CREATE INDEX documents_dealership_id_idx
  ON public.documents (dealership_id);
CREATE INDEX backdrops_dealership_id_idx
  ON public.backdrops (dealership_id);
CREATE INDEX user_invitations_dealership_id_idx
  ON public.user_invitations (dealership_id);

-- These helpers are intentionally in a non-exposed schema. They accept no
-- caller-supplied identity and always derive the caller from auth.uid().
CREATE OR REPLACE FUNCTION private.current_user_is_active_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = (SELECT auth.uid())
      AND p.status = 'active'
      AND p.role = 'owner'::public.app_role
  );
$$;

CREATE OR REPLACE FUNCTION private.current_user_dealership_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.dealership_id
  FROM public.profiles AS p
  JOIN public.dealerships AS d ON d.id = p.dealership_id
  WHERE p.id = (SELECT auth.uid())
    AND p.status = 'active'
    AND p.role <> 'owner'::public.app_role
    AND d.status IN ('active', 'trial')
    AND d.subscription_status = 'active'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION private.current_user_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = (SELECT auth.uid())
      AND p.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION private.current_user_has_active_membership(_dealership_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT private.current_user_is_active_owner())
    OR (SELECT private.current_user_dealership_id()) = _dealership_id;
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
      JOIN public.dealerships AS d ON d.id = p.dealership_id
      WHERE p.id = (SELECT auth.uid())
        AND p.status = 'active'
        AND p.role = 'dealer_admin'::public.app_role
        AND p.dealership_id = _dealership_id
        AND d.status IN ('active', 'trial')
        AND d.subscription_status = 'active'
    );
$$;

CREATE OR REPLACE FUNCTION private.current_user_can_access_vehicle(_vehicle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.vehicles AS v
    WHERE v.id = _vehicle_id
      AND (SELECT private.current_user_has_active_membership(v.dealership_id))
  );
$$;

CREATE OR REPLACE FUNCTION private.current_user_can_access_vehicle_document(
  _vehicle_id uuid,
  _document_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.vehicles AS v
    JOIN public.documents AS d ON d.dealership_id = v.dealership_id
    WHERE v.id = _vehicle_id
      AND d.id = _document_id
      AND (SELECT private.current_user_has_active_membership(v.dealership_id))
  );
$$;

-- Storage paths are text. Invalid or adversarial UUID path segments fail closed
-- instead of surfacing a cast error from a policy expression.
CREATE OR REPLACE FUNCTION private.current_user_has_active_membership_text(_dealership_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN private.current_user_has_active_membership(_dealership_id::uuid);
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION private.current_user_can_access_vehicle_text(_vehicle_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN private.current_user_can_access_vehicle(_vehicle_id::uuid);
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION private.current_user_is_active_owner() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_dealership_id() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_is_active() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_has_active_membership(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_is_dealership_admin(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_can_access_vehicle(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_can_access_vehicle_document(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_has_active_membership_text(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_can_access_vehicle_text(text) FROM PUBLIC, anon, authenticated, service_role;
-- RLS expressions execute as the requesting database role, so authenticated
-- needs EXECUTE. With no USAGE on the private schema and no Data API exposure,
-- the helpers cannot be resolved as client-callable RPCs.
GRANT EXECUTE ON FUNCTION private.current_user_is_active_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_dealership_id() TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_is_active() TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_has_active_membership(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_is_dealership_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_can_access_vehicle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_can_access_vehicle_document(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_has_active_membership_text(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_can_access_vehicle_text(text) TO authenticated;

-- Replace every tenant policy so active account/dealership state is part of the
-- database authorization decision. Explicit WITH CHECK clauses prevent tenant
-- reassignment through UPDATE.
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Owners can insert profiles" ON public.profiles;
DROP POLICY IF EXISTS "Owners can delete profiles" ON public.profiles;

CREATE POLICY "Active users view permitted profiles"
ON public.profiles FOR SELECT TO authenticated
USING (
  (SELECT private.current_user_is_active_owner())
  OR (
    id = (SELECT auth.uid())
    AND (SELECT private.current_user_is_active())
  )
);

CREATE POLICY "Active users update own safe profile"
ON public.profiles FOR UPDATE TO authenticated
USING (
  id = (SELECT auth.uid())
  AND (SELECT private.current_user_is_active())
)
WITH CHECK (
  id = (SELECT auth.uid())
  AND status = 'active'
  AND (SELECT private.current_user_is_active())
);

CREATE POLICY "Active owners insert profiles"
ON public.profiles FOR INSERT TO authenticated
WITH CHECK ((SELECT private.current_user_is_active_owner()));

CREATE POLICY "Active owners delete profiles"
ON public.profiles FOR DELETE TO authenticated
USING ((SELECT private.current_user_is_active_owner()));

DROP POLICY IF EXISTS "View own dealership" ON public.dealerships;
DROP POLICY IF EXISTS "Owners manage dealerships - insert" ON public.dealerships;
DROP POLICY IF EXISTS "Owners manage dealerships - update" ON public.dealerships;
DROP POLICY IF EXISTS "Owners manage dealerships - delete" ON public.dealerships;

CREATE POLICY "Active users view permitted dealerships"
ON public.dealerships FOR SELECT TO authenticated
USING (
  (SELECT private.current_user_is_active_owner())
  OR id = (SELECT private.current_user_dealership_id())
);

CREATE POLICY "Active owners insert dealerships"
ON public.dealerships FOR INSERT TO authenticated
WITH CHECK ((SELECT private.current_user_is_active_owner()));

CREATE POLICY "Active owners update dealerships"
ON public.dealerships FOR UPDATE TO authenticated
USING ((SELECT private.current_user_is_active_owner()))
WITH CHECK ((SELECT private.current_user_is_active_owner()));

CREATE POLICY "Active owners delete dealerships"
ON public.dealerships FOR DELETE TO authenticated
USING ((SELECT private.current_user_is_active_owner()));

DROP POLICY IF EXISTS "View vehicles in dealership" ON public.vehicles;
DROP POLICY IF EXISTS "Insert vehicles in dealership" ON public.vehicles;
DROP POLICY IF EXISTS "Update vehicles in dealership" ON public.vehicles;
DROP POLICY IF EXISTS "Delete vehicles in dealership" ON public.vehicles;

CREATE POLICY "Active members view vehicles"
ON public.vehicles FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members insert vehicles"
ON public.vehicles FOR INSERT TO authenticated
WITH CHECK (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members update vehicles"
ON public.vehicles FOR UPDATE TO authenticated
USING (private.current_user_has_active_membership(dealership_id))
WITH CHECK (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active administrators delete vehicles"
ON public.vehicles FOR DELETE TO authenticated
USING (private.current_user_is_dealership_admin(dealership_id));

DROP POLICY IF EXISTS "View photos in dealership" ON public.photos;
DROP POLICY IF EXISTS "Insert photos in dealership" ON public.photos;
DROP POLICY IF EXISTS "Update photos in dealership" ON public.photos;
DROP POLICY IF EXISTS "Delete photos in dealership" ON public.photos;

CREATE POLICY "Active members view photos"
ON public.photos FOR SELECT TO authenticated
USING (private.current_user_can_access_vehicle(vehicle_id));

CREATE POLICY "Active members insert photos"
ON public.photos FOR INSERT TO authenticated
WITH CHECK (private.current_user_can_access_vehicle(vehicle_id));

CREATE POLICY "Active members update photos"
ON public.photos FOR UPDATE TO authenticated
USING (private.current_user_can_access_vehicle(vehicle_id))
WITH CHECK (private.current_user_can_access_vehicle(vehicle_id));

CREATE POLICY "Active members delete photos"
ON public.photos FOR DELETE TO authenticated
USING (private.current_user_can_access_vehicle(vehicle_id));

DROP POLICY IF EXISTS "View overlays in dealership" ON public.overlay_templates;
DROP POLICY IF EXISTS "Insert overlays in dealership" ON public.overlay_templates;
DROP POLICY IF EXISTS "Update overlays in dealership" ON public.overlay_templates;
DROP POLICY IF EXISTS "Delete overlays in dealership" ON public.overlay_templates;

CREATE POLICY "Active members view overlays"
ON public.overlay_templates FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members insert overlays"
ON public.overlay_templates FOR INSERT TO authenticated
WITH CHECK (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members update overlays"
ON public.overlay_templates FOR UPDATE TO authenticated
USING (private.current_user_has_active_membership(dealership_id))
WITH CHECK (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members delete overlays"
ON public.overlay_templates FOR DELETE TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

DROP POLICY IF EXISTS "View documents in dealership" ON public.documents;
DROP POLICY IF EXISTS "Insert documents in dealership" ON public.documents;
DROP POLICY IF EXISTS "Update documents in dealership" ON public.documents;
DROP POLICY IF EXISTS "Delete documents in dealership" ON public.documents;

CREATE POLICY "Active members view documents"
ON public.documents FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members insert documents"
ON public.documents FOR INSERT TO authenticated
WITH CHECK (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members update documents"
ON public.documents FOR UPDATE TO authenticated
USING (private.current_user_has_active_membership(dealership_id))
WITH CHECK (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members delete documents"
ON public.documents FOR DELETE TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

DROP POLICY IF EXISTS "View vehicle_documents in dealership" ON public.vehicle_documents;
DROP POLICY IF EXISTS "Insert vehicle_documents in dealership" ON public.vehicle_documents;
DROP POLICY IF EXISTS "Update vehicle_documents in dealership" ON public.vehicle_documents;
DROP POLICY IF EXISTS "Delete vehicle_documents in dealership" ON public.vehicle_documents;

CREATE POLICY "Active members view vehicle documents"
ON public.vehicle_documents FOR SELECT TO authenticated
USING (private.current_user_can_access_vehicle_document(vehicle_id, document_id));

CREATE POLICY "Active members insert vehicle documents"
ON public.vehicle_documents FOR INSERT TO authenticated
WITH CHECK (private.current_user_can_access_vehicle_document(vehicle_id, document_id));

CREATE POLICY "Active members update vehicle documents"
ON public.vehicle_documents FOR UPDATE TO authenticated
USING (private.current_user_can_access_vehicle_document(vehicle_id, document_id))
WITH CHECK (private.current_user_can_access_vehicle_document(vehicle_id, document_id));

CREATE POLICY "Active members delete vehicle documents"
ON public.vehicle_documents FOR DELETE TO authenticated
USING (private.current_user_can_access_vehicle_document(vehicle_id, document_id));

DROP POLICY IF EXISTS "View backdrops in dealership" ON public.backdrops;
DROP POLICY IF EXISTS "Insert backdrops in dealership" ON public.backdrops;
DROP POLICY IF EXISTS "Update backdrops in dealership" ON public.backdrops;
DROP POLICY IF EXISTS "Delete backdrops in dealership" ON public.backdrops;

CREATE POLICY "Active members view backdrops"
ON public.backdrops FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members insert backdrops"
ON public.backdrops FOR INSERT TO authenticated
WITH CHECK (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members update backdrops"
ON public.backdrops FOR UPDATE TO authenticated
USING (private.current_user_has_active_membership(dealership_id))
WITH CHECK (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members delete backdrops"
ON public.backdrops FOR DELETE TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

DROP POLICY IF EXISTS "Owners can view impersonation logs" ON public.impersonation_logs;
DROP POLICY IF EXISTS "Owners can insert impersonation logs" ON public.impersonation_logs;
DROP POLICY IF EXISTS "Owners can update impersonation logs" ON public.impersonation_logs;

CREATE POLICY "Active owners view impersonation logs"
ON public.impersonation_logs FOR SELECT TO authenticated
USING ((SELECT private.current_user_is_active_owner()));

CREATE POLICY "Active owners insert impersonation logs"
ON public.impersonation_logs FOR INSERT TO authenticated
WITH CHECK (
  (SELECT private.current_user_is_active_owner())
  AND owner_id = (SELECT auth.uid())
);

CREATE POLICY "Active owners update own impersonation logs"
ON public.impersonation_logs FOR UPDATE TO authenticated
USING (
  (SELECT private.current_user_is_active_owner())
  AND owner_id = (SELECT auth.uid())
)
WITH CHECK (
  (SELECT private.current_user_is_active_owner())
  AND owner_id = (SELECT auth.uid())
);

DROP POLICY IF EXISTS "Owners view invitations" ON public.user_invitations;
DROP POLICY IF EXISTS "Owners insert invitations" ON public.user_invitations;
DROP POLICY IF EXISTS "Owners update invitations" ON public.user_invitations;
DROP POLICY IF EXISTS "Owners delete invitations" ON public.user_invitations;

CREATE POLICY "Active owners view invitations"
ON public.user_invitations FOR SELECT TO authenticated
USING ((SELECT private.current_user_is_active_owner()));

CREATE POLICY "Active owners insert invitations"
ON public.user_invitations FOR INSERT TO authenticated
WITH CHECK (
  (SELECT private.current_user_is_active_owner())
  AND invited_by = (SELECT auth.uid())
  AND role IN ('dealer_admin', 'staff')
  AND dealership_id IS NOT NULL
);

CREATE POLICY "Active owners update invitations"
ON public.user_invitations FOR UPDATE TO authenticated
USING ((SELECT private.current_user_is_active_owner()))
WITH CHECK (
  (SELECT private.current_user_is_active_owner())
  AND role IN ('dealer_admin', 'staff')
  AND dealership_id IS NOT NULL
);

CREATE POLICY "Active owners delete invitations"
ON public.user_invitations FOR DELETE TO authenticated
USING ((SELECT private.current_user_is_active_owner()));

-- Public buckets intentionally retain public reads in this phase. Every write
-- policy now checks active identity plus trusted database membership.
DROP POLICY IF EXISTS "Read documents in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Insert vehicle photos in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Update vehicle photos in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Delete vehicle photos in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Insert overlays in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Update overlays in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Delete overlays in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Insert backdrops in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Update backdrops in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Delete backdrops in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Insert documents in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Update documents in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Delete documents in own dealership" ON storage.objects;
DROP POLICY IF EXISTS "Owners insert dealership logos" ON storage.objects;
DROP POLICY IF EXISTS "Owners update dealership logos" ON storage.objects;
DROP POLICY IF EXISTS "Owners delete dealership logos" ON storage.objects;

CREATE POLICY "Active members read dealership documents"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'documents'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members insert vehicle photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'vehicle-photos'
  AND private.current_user_can_access_vehicle_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members update vehicle photos"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'vehicle-photos'
  AND private.current_user_can_access_vehicle_text((storage.foldername(name))[1])
)
WITH CHECK (
  bucket_id = 'vehicle-photos'
  AND private.current_user_can_access_vehicle_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members delete vehicle photos"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'vehicle-photos'
  AND private.current_user_can_access_vehicle_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members insert overlays"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'overlays'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members update overlays"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'overlays'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
)
WITH CHECK (
  bucket_id = 'overlays'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members delete overlays"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'overlays'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members insert backdrops"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'backdrops'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members update backdrops"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'backdrops'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
)
WITH CHECK (
  bucket_id = 'backdrops'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members delete backdrops"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'backdrops'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members insert documents"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'documents'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members update documents"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'documents'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
)
WITH CHECK (
  bucket_id = 'documents'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
);

CREATE POLICY "Active members delete documents"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'documents'
  AND private.current_user_has_active_membership_text((storage.foldername(name))[1])
);

CREATE POLICY "Active owners insert dealership logos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'dealership-logos'
  AND (SELECT private.current_user_is_active_owner())
);

CREATE POLICY "Active owners update dealership logos"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'dealership-logos'
  AND (SELECT private.current_user_is_active_owner())
)
WITH CHECK (
  bucket_id = 'dealership-logos'
  AND (SELECT private.current_user_is_active_owner())
);

CREATE POLICY "Active owners delete dealership logos"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'dealership-logos'
  AND (SELECT private.current_user_is_active_owner())
);

-- Remove the caller-controlled public helpers after all dependent policies have
-- been replaced. Their arbitrary user-id arguments exposed role/membership data.
DROP FUNCTION IF EXISTS public.has_role(uuid, public.app_role);
DROP FUNCTION IF EXISTS public.get_user_dealership(uuid);

-- Direct browser profile writes are limited to the non-security-sensitive name
-- field. Administrative changes use an authenticated server function and the
-- server-only service role.
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;
GRANT SELECT ON public.profiles TO authenticated;
GRANT UPDATE (full_name) ON public.profiles TO authenticated;

-- Harden existing trigger/RPC functions with an empty search_path and explicit
-- object qualification. Invitation acceptance is the only non-admin pathway
-- that may assign an initial role/dealership, and it is restricted to pristine
-- placeholder profiles plus active dealerships and non-owner roles.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'staff'::public.app_role
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_invitation_details(_token text)
RETURNS TABLE (
  id uuid,
  email text,
  full_name text,
  role text,
  dealership_id uuid,
  dealership_name text,
  expires_at timestamptz,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT i.id, i.email, i.full_name, i.role, i.dealership_id,
         d.name AS dealership_name, i.expires_at, i.status
  FROM public.user_invitations AS i
  LEFT JOIN public.dealerships AS d ON d.id = i.dealership_id
  WHERE i.token = _token;
$$;

REVOKE ALL ON FUNCTION public.get_invitation_details(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invitation_details(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_invitation_account_exists(_token text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_invitations AS i
    JOIN auth.users AS u ON lower(u.email) = lower(i.email)
    WHERE i.token = _token
      AND u.created_at < (i.invited_at - interval '5 seconds')
  );
$$;

REVOKE ALL ON FUNCTION public.check_invitation_account_exists(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_invitation_account_exists(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.accept_invitation(_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inv public.user_invitations%ROWTYPE;
  current_email text;
  current_profile public.profiles%ROWTYPE;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT u.email
  INTO current_email
  FROM auth.users AS u
  WHERE u.id = (SELECT auth.uid());

  SELECT *
  INTO inv
  FROM public.user_invitations
  WHERE token = _token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found';
  END IF;

  IF inv.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is no longer valid';
  END IF;

  IF inv.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation has expired';
  END IF;

  IF current_email IS NULL OR lower(inv.email) IS DISTINCT FROM lower(current_email) THEN
    RAISE EXCEPTION 'Invitation email does not match signed-in user';
  END IF;

  IF inv.role NOT IN ('dealer_admin', 'staff') OR inv.dealership_id IS NULL THEN
    RAISE EXCEPTION 'Invitation contains an unauthorized role or dealership';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.dealerships AS d
    WHERE d.id = inv.dealership_id
      AND d.status IN ('active', 'trial')
      AND d.subscription_status = 'active'
  ) THEN
    RAISE EXCEPTION 'Invitation dealership is not active';
  END IF;

  SELECT *
  INTO current_profile
  FROM public.profiles
  WHERE id = (SELECT auth.uid())
  FOR UPDATE;

  IF NOT FOUND
    OR current_profile.status <> 'active'
    OR current_profile.role <> 'staff'::public.app_role
    OR current_profile.dealership_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'Existing account cannot accept this invitation';
  END IF;

  UPDATE public.profiles
  SET role = inv.role::public.app_role,
      dealership_id = inv.dealership_id,
      full_name = COALESCE(NULLIF(inv.full_name, ''), full_name)
  WHERE id = (SELECT auth.uid());

  UPDATE public.user_invitations
  SET status = 'accepted', accepted_at = now()
  WHERE id = inv.id;

  RETURN jsonb_build_object('ok', true, 'dealership_id', inv.dealership_id);
END;
$$;

REVOKE ALL ON FUNCTION public.accept_invitation(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO authenticated;
