
CREATE TABLE public.backdrops (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dealership_id UUID NOT NULL,
  name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.backdrops TO authenticated;
GRANT ALL ON public.backdrops TO service_role;

ALTER TABLE public.backdrops ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View backdrops in dealership" ON public.backdrops
  FOR SELECT TO authenticated
  USING ((dealership_id = get_user_dealership(auth.uid())) OR has_role(auth.uid(), 'owner'::app_role));

CREATE POLICY "Insert backdrops in dealership" ON public.backdrops
  FOR INSERT TO authenticated
  WITH CHECK ((dealership_id = get_user_dealership(auth.uid())) OR has_role(auth.uid(), 'owner'::app_role));

CREATE POLICY "Update backdrops in dealership" ON public.backdrops
  FOR UPDATE TO authenticated
  USING ((dealership_id = get_user_dealership(auth.uid())) OR has_role(auth.uid(), 'owner'::app_role));

CREATE POLICY "Delete backdrops in dealership" ON public.backdrops
  FOR DELETE TO authenticated
  USING ((dealership_id = get_user_dealership(auth.uid())) OR has_role(auth.uid(), 'owner'::app_role));

INSERT INTO storage.buckets (id, name, public) VALUES ('backdrops', 'backdrops', true)
  ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Backdrops are publicly viewable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'backdrops');

CREATE POLICY "Authenticated can upload backdrops"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'backdrops');

CREATE POLICY "Authenticated can update backdrops"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'backdrops');

CREATE POLICY "Authenticated can delete backdrops"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'backdrops');
