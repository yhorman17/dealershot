-- The capability-scoped policy introduced with default backdrop selection
-- supersedes the older active-membership-only read policy.
DROP POLICY IF EXISTS "Active members view backdrops" ON public.backdrops;
