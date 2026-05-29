
UPDATE storage.buckets SET public = false WHERE id = 'documents';

DROP POLICY IF EXISTS "Authenticated can delete backdrops" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can delete documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can delete vehicle photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update backdrops" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update vehicle photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload backdrops" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload vehicle photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete dealership logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete overlays" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update dealership logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update overlays" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload dealership logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload overlays" ON storage.objects;
DROP POLICY IF EXISTS "Backdrops are publicly viewable" ON storage.objects;
DROP POLICY IF EXISTS "Dealership logos are publicly viewable" ON storage.objects;
DROP POLICY IF EXISTS "Overlays are publicly viewable" ON storage.objects;
DROP POLICY IF EXISTS "Public can view documents" ON storage.objects;
DROP POLICY IF EXISTS "Public can view vehicle photos" ON storage.objects;

CREATE POLICY "Public read vehicle photos" ON storage.objects FOR SELECT
  USING (bucket_id = 'vehicle-photos');
CREATE POLICY "Public read overlays" ON storage.objects FOR SELECT
  USING (bucket_id = 'overlays');
CREATE POLICY "Public read backdrops" ON storage.objects FOR SELECT
  USING (bucket_id = 'backdrops');
CREATE POLICY "Public read dealership logos" ON storage.objects FOR SELECT
  USING (bucket_id = 'dealership-logos');

CREATE POLICY "Read documents in own dealership" ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'documents' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  );

CREATE POLICY "Insert vehicle photos in own dealership" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'vehicle-photos' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR EXISTS (SELECT 1 FROM public.vehicles v
        WHERE v.id::text = (storage.foldername(name))[1]
          AND v.dealership_id = public.get_user_dealership(auth.uid()))
    )
  );
CREATE POLICY "Update vehicle photos in own dealership" ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'vehicle-photos' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR EXISTS (SELECT 1 FROM public.vehicles v
        WHERE v.id::text = (storage.foldername(name))[1]
          AND v.dealership_id = public.get_user_dealership(auth.uid()))
    )
  )
  WITH CHECK (
    bucket_id = 'vehicle-photos' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR EXISTS (SELECT 1 FROM public.vehicles v
        WHERE v.id::text = (storage.foldername(name))[1]
          AND v.dealership_id = public.get_user_dealership(auth.uid()))
    )
  );
CREATE POLICY "Delete vehicle photos in own dealership" ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'vehicle-photos' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR EXISTS (SELECT 1 FROM public.vehicles v
        WHERE v.id::text = (storage.foldername(name))[1]
          AND v.dealership_id = public.get_user_dealership(auth.uid()))
    )
  );

CREATE POLICY "Insert overlays in own dealership" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'overlays' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  );
CREATE POLICY "Update overlays in own dealership" ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'overlays' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  )
  WITH CHECK (
    bucket_id = 'overlays' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  );
CREATE POLICY "Delete overlays in own dealership" ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'overlays' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  );

CREATE POLICY "Insert backdrops in own dealership" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'backdrops' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  );
CREATE POLICY "Update backdrops in own dealership" ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'backdrops' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  )
  WITH CHECK (
    bucket_id = 'backdrops' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  );
CREATE POLICY "Delete backdrops in own dealership" ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'backdrops' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  );

CREATE POLICY "Insert documents in own dealership" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'documents' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  );
CREATE POLICY "Update documents in own dealership" ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'documents' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  )
  WITH CHECK (
    bucket_id = 'documents' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  );
CREATE POLICY "Delete documents in own dealership" ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'documents' AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR (storage.foldername(name))[1] = public.get_user_dealership(auth.uid())::text
    )
  );

CREATE POLICY "Owners insert dealership logos" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'dealership-logos' AND public.has_role(auth.uid(), 'owner'::public.app_role)
  );
CREATE POLICY "Owners update dealership logos" ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'dealership-logos' AND public.has_role(auth.uid(), 'owner'::public.app_role)
  )
  WITH CHECK (
    bucket_id = 'dealership-logos' AND public.has_role(auth.uid(), 'owner'::public.app_role)
  );
CREATE POLICY "Owners delete dealership logos" ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'dealership-logos' AND public.has_role(auth.uid(), 'owner'::public.app_role)
  );
