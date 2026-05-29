-- 1. Add status to profiles (active | deactivated)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- 2. user_invitations table
CREATE TABLE public.user_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  full_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('dealer_admin', 'staff', 'owner')),
  dealership_id uuid REFERENCES public.dealerships(id) ON DELETE CASCADE,
  invited_by uuid NOT NULL,
  invited_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked'))
);

CREATE INDEX idx_user_invitations_token ON public.user_invitations(token);
CREATE INDEX idx_user_invitations_email ON public.user_invitations(lower(email));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_invitations TO authenticated;
GRANT ALL ON public.user_invitations TO service_role;

ALTER TABLE public.user_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners view invitations"
  ON public.user_invitations FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE POLICY "Owners insert invitations"
  ON public.user_invitations FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'owner'::app_role) AND invited_by = auth.uid());

CREATE POLICY "Owners update invitations"
  ON public.user_invitations FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE POLICY "Owners delete invitations"
  ON public.user_invitations FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

-- 3. RPC to look up invitation details by token (used on accept-invite page)
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
SET search_path = public
AS $$
  SELECT i.id, i.email, i.full_name, i.role, i.dealership_id,
         d.name AS dealership_name, i.expires_at, i.status
  FROM public.user_invitations i
  LEFT JOIN public.dealerships d ON d.id = i.dealership_id
  WHERE i.token = _token;
$$;

GRANT EXECUTE ON FUNCTION public.get_invitation_details(text) TO anon, authenticated;

-- 4. RPC to accept an invitation as the currently signed-in user
CREATE OR REPLACE FUNCTION public.accept_invitation(_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv public.user_invitations%ROWTYPE;
  current_email text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT email INTO current_email FROM auth.users WHERE id = auth.uid();

  SELECT * INTO inv FROM public.user_invitations WHERE token = _token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found';
  END IF;

  IF inv.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is no longer valid';
  END IF;

  IF inv.expires_at < now() THEN
    UPDATE public.user_invitations SET status = 'expired' WHERE id = inv.id;
    RAISE EXCEPTION 'Invitation has expired';
  END IF;

  IF lower(inv.email) <> lower(current_email) THEN
    RAISE EXCEPTION 'Invitation email does not match signed-in user';
  END IF;

  UPDATE public.profiles
    SET role = inv.role::app_role,
        dealership_id = inv.dealership_id,
        full_name = COALESCE(NULLIF(inv.full_name, ''), full_name),
        status = 'active'
    WHERE id = auth.uid();

  UPDATE public.user_invitations
    SET status = 'accepted', accepted_at = now()
    WHERE id = inv.id;

  RETURN jsonb_build_object('ok', true, 'dealership_id', inv.dealership_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO authenticated;