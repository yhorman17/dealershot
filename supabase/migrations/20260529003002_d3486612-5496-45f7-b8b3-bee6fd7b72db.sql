-- 1. Add status column to dealerships with allowed values
ALTER TABLE public.dealerships
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE public.dealerships
  DROP CONSTRAINT IF EXISTS dealerships_status_check;

ALTER TABLE public.dealerships
  ADD CONSTRAINT dealerships_status_check
  CHECK (status IN ('active', 'trial', 'suspended'));

-- 2. Impersonation logs table
CREATE TABLE IF NOT EXISTS public.impersonation_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id uuid NOT NULL,
  dealership_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.impersonation_logs TO authenticated;
GRANT ALL ON public.impersonation_logs TO service_role;

ALTER TABLE public.impersonation_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view impersonation logs"
  ON public.impersonation_logs
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));

CREATE POLICY "Owners can insert impersonation logs"
  ON public.impersonation_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'owner') AND owner_id = auth.uid());

CREATE POLICY "Owners can update impersonation logs"
  ON public.impersonation_logs
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'owner') AND owner_id = auth.uid());
