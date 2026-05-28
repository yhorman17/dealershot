-- Documents table: reusable images attached to one or many vehicles
CREATE TABLE public.documents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  name text NOT NULL,
  image_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;
GRANT ALL ON public.documents TO service_role;

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View documents in dealership" ON public.documents FOR SELECT TO authenticated
  USING (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Insert documents in dealership" ON public.documents FOR INSERT TO authenticated
  WITH CHECK (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Update documents in dealership" ON public.documents FOR UPDATE TO authenticated
  USING (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Delete documents in dealership" ON public.documents FOR DELETE TO authenticated
  USING (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));

-- Join table: attach documents to vehicles
CREATE TABLE public.vehicle_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, document_id)
);

CREATE INDEX idx_vehicle_documents_vehicle ON public.vehicle_documents(vehicle_id);
CREATE INDEX idx_vehicle_documents_document ON public.vehicle_documents(document_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicle_documents TO authenticated;
GRANT ALL ON public.vehicle_documents TO service_role;

ALTER TABLE public.vehicle_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View vehicle_documents in dealership" ON public.vehicle_documents FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_documents.vehicle_id
      AND v.dealership_id = public.get_user_dealership(auth.uid())
  ));
CREATE POLICY "Insert vehicle_documents in dealership" ON public.vehicle_documents FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'owner') OR EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_documents.vehicle_id
      AND v.dealership_id = public.get_user_dealership(auth.uid())
  ));
CREATE POLICY "Update vehicle_documents in dealership" ON public.vehicle_documents FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_documents.vehicle_id
      AND v.dealership_id = public.get_user_dealership(auth.uid())
  ));
CREATE POLICY "Delete vehicle_documents in dealership" ON public.vehicle_documents FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_documents.vehicle_id
      AND v.dealership_id = public.get_user_dealership(auth.uid())
  ));

-- Public storage bucket for document images
INSERT INTO storage.buckets (id, name, public) VALUES ('documents', 'documents', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public can view documents" ON storage.objects FOR SELECT
  USING (bucket_id = 'documents');
CREATE POLICY "Authenticated can upload documents" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents');
CREATE POLICY "Authenticated can update documents" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'documents');
CREATE POLICY "Authenticated can delete documents" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'documents');
