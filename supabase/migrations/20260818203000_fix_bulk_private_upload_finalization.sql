-- Allow the trusted private-media finalizer to append a Bulk item while
-- retaining the original browser-side capture-session authorization guard.
--
-- finalize_private_bulk_upload is executable only by service_role and already
-- validates the supplied actor, store, session, path, MIME, size and checksum.
-- Its INSERT still crosses this legacy trigger, where auth.uid() is null for a
-- service-role request. Validate NEW.created_by explicitly for that trusted
-- path instead of treating the server finalizer as an anonymous browser write.

CREATE OR REPLACE FUNCTION private.serialize_bulk_photo_item_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.photo_capture_sessions;
  browser_actor uuid := (SELECT auth.uid());
  request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none')
  );
  trusted_finalizer boolean := false;
BEGIN
  SELECT * INTO target
  FROM public.photo_capture_sessions
  WHERE id = NEW.session_id
  FOR UPDATE;

  trusted_finalizer := request_role = 'service_role'
    AND NEW.created_by IS NOT NULL
    AND NEW.media_asset_id IS NOT NULL
    AND target.id IS NOT NULL
    AND target.status = 'in_progress'
    AND private.actor_can_upload_media(
      NEW.created_by,
      target.dealership_id,
      target.vehicle_id,
      target.id
    );

  IF target.id IS NULL
    OR target.status <> 'in_progress'
    OR NOT (
      (browser_actor IS NOT NULL
        AND private.current_user_can_mutate_capture_session(target.id))
      OR trusted_finalizer
    )
  THEN
    RAISE EXCEPTION 'Capture session is no longer accepting photos.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.serialize_bulk_photo_item_insert()
FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.serialize_bulk_photo_item_insert() IS
  'Serializes Bulk media registration and authorizes either the browser actor or the service-only trusted Media Ledger finalizer.';
