ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_main boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS photos_one_main_per_vehicle
  ON public.photos (vehicle_id)
  WHERE is_main = true;

CREATE INDEX IF NOT EXISTS photos_vehicle_sort_idx
  ON public.photos (vehicle_id, sort_order);