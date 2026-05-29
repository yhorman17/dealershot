
ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS is_cutout boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cutout_status text NOT NULL DEFAULT 'none';
-- cutout_status values: 'none' | 'pending' | 'done' | 'failed'
