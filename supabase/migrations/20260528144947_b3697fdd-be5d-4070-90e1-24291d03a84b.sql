INSERT INTO storage.buckets (id, name, public)
VALUES ('dealership-logos', 'dealership-logos', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Dealership logos are publicly viewable"
ON storage.objects FOR SELECT
USING (bucket_id = 'dealership-logos');

CREATE POLICY "Authenticated users can upload dealership logos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'dealership-logos');

CREATE POLICY "Authenticated users can update dealership logos"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'dealership-logos');

CREATE POLICY "Authenticated users can delete dealership logos"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'dealership-logos');