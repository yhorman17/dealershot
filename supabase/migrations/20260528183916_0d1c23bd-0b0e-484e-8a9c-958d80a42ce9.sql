
INSERT INTO storage.buckets (id, name, public)
VALUES ('overlays', 'overlays', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Overlays are publicly viewable"
ON storage.objects FOR SELECT
USING (bucket_id = 'overlays');

CREATE POLICY "Authenticated users can upload overlays"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'overlays');

CREATE POLICY "Authenticated users can update overlays"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'overlays');

CREATE POLICY "Authenticated users can delete overlays"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'overlays');
