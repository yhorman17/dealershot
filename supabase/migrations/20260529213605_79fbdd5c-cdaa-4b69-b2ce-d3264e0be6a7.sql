DROP POLICY IF EXISTS "Delete vehicles in dealership" ON public.vehicles;

CREATE POLICY "Delete vehicles in dealership"
ON public.vehicles
FOR DELETE
TO authenticated
USING (
  has_role(auth.uid(), 'owner'::app_role)
  OR (
    dealership_id = get_user_dealership(auth.uid())
    AND has_role(auth.uid(), 'dealer_admin'::app_role)
  )
);