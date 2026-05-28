ALTER TABLE public.vehicle_documents ADD COLUMN is_main boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX vehicle_documents_one_main_per_vehicle
  ON public.vehicle_documents(vehicle_id) WHERE is_main;
