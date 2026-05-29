
CREATE OR REPLACE FUNCTION public.check_invitation_account_exists(_token text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_invitations i
    JOIN auth.users u ON lower(u.email) = lower(i.email)
    WHERE i.token = _token
      AND u.created_at < (i.invited_at - interval '5 seconds')
  );
$$;

GRANT EXECUTE ON FUNCTION public.check_invitation_account_exists(text) TO anon, authenticated;
