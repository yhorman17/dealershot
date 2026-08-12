-- Fast, durable photo intake without starting the future Media Ledger phase.
-- Capture sessions represent photographer workflow completion; raw bytes are
-- uploaded before a photo/item row is created, so completion is not persistence.

CREATE TABLE public.photo_capture_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  vin text,
  mode text NOT NULL CHECK (mode IN ('guided', 'bulk')),
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'prepared')),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  completed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  completed_at timestamptz,
  prepared_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  prepared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (vin IS NULL OR (vin = upper(btrim(vin)) AND vin ~ '^[A-HJ-NPR-Z0-9]{8,17}$')),
  CHECK (mode <> 'bulk' OR vin IS NOT NULL),
  CHECK (
    (status = 'in_progress' AND completed_at IS NULL AND completed_by IS NULL)
    OR (status IN ('completed', 'prepared') AND completed_at IS NOT NULL AND completed_by IS NOT NULL)
  ),
  CHECK (
    (status <> 'prepared' AND prepared_at IS NULL AND prepared_by IS NULL)
    OR (status = 'prepared' AND prepared_at IS NOT NULL AND prepared_by IS NOT NULL)
  )
);

CREATE INDEX photo_capture_sessions_dealership_status_idx
  ON public.photo_capture_sessions (dealership_id, status, created_at DESC);
CREATE INDEX photo_capture_sessions_vehicle_idx
  ON public.photo_capture_sessions (vehicle_id, created_at DESC)
  WHERE vehicle_id IS NOT NULL;
CREATE INDEX photo_capture_sessions_vin_idx
  ON public.photo_capture_sessions (dealership_id, vin, created_at DESC);
CREATE INDEX photo_capture_sessions_created_by_idx
  ON public.photo_capture_sessions (created_by, created_at DESC);
CREATE UNIQUE INDEX photo_capture_sessions_one_guided_in_progress_idx
  ON public.photo_capture_sessions (vehicle_id, created_by)
  WHERE mode = 'guided' AND status = 'in_progress' AND vehicle_id IS NOT NULL;

CREATE TABLE public.bulk_photo_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.photo_capture_sessions(id) ON DELETE CASCADE,
  image_url text NOT NULL,
  storage_path text NOT NULL,
  shot_type text,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_main boolean NOT NULL DEFAULT false,
  photo_id uuid REFERENCES public.photos(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, storage_path),
  UNIQUE (photo_id)
);

CREATE INDEX bulk_photo_items_session_order_idx
  ON public.bulk_photo_items (session_id, is_main DESC, sort_order, created_at);
CREATE UNIQUE INDEX bulk_photo_items_one_main_per_session_idx
  ON public.bulk_photo_items (session_id)
  WHERE is_main;

ALTER TABLE public.photos
  ADD COLUMN capture_session_id uuid REFERENCES public.photo_capture_sessions(id) ON DELETE SET NULL,
  ADD COLUMN original_image_url text,
  ADD COLUMN cutout_image_url text,
  ADD COLUMN corrected_cutout_url text,
  ADD COLUMN photo_state text NOT NULL DEFAULT 'raw'
    CHECK (photo_state IN ('raw', 'cutout', 'customized'));

UPDATE public.photos
SET original_image_url = image_url
WHERE original_image_url IS NULL;

ALTER TABLE public.photos
  ALTER COLUMN original_image_url SET NOT NULL;

CREATE OR REPLACE FUNCTION private.preserve_photo_original()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.original_image_url := OLD.original_image_url;
  ELSE
    NEW.original_image_url := COALESCE(NEW.original_image_url, NEW.image_url);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER preserve_photo_original
BEFORE INSERT OR UPDATE ON public.photos
FOR EACH ROW EXECUTE FUNCTION private.preserve_photo_original();

REVOKE ALL ON FUNCTION private.preserve_photo_original()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.validate_photo_capture_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.photo_capture_sessions;
  vehicle_dealership_id uuid;
BEGIN
  IF NEW.capture_session_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO target
  FROM public.photo_capture_sessions
  WHERE id = NEW.capture_session_id
  FOR UPDATE;

  SELECT dealership_id INTO vehicle_dealership_id
  FROM public.vehicles
  WHERE id = NEW.vehicle_id;

  IF target.id IS NULL
    OR target.dealership_id IS DISTINCT FROM vehicle_dealership_id
    OR (target.vehicle_id IS NOT NULL AND target.vehicle_id <> NEW.vehicle_id)
    OR NOT (
      (
        target.mode = 'guided'
        AND target.status = 'in_progress'
        AND target.created_by = (SELECT auth.uid())
      )
      OR (
        target.mode = 'bulk'
        AND target.status = 'completed'
        AND private.current_user_is_dealership_admin(target.dealership_id)
      )
    )
  THEN
    RAISE EXCEPTION 'Photo capture session does not match the vehicle.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_photo_capture_session
BEFORE INSERT OR UPDATE OF capture_session_id, vehicle_id ON public.photos
FOR EACH ROW EXECUTE FUNCTION private.validate_photo_capture_session();

REVOKE ALL ON FUNCTION private.validate_photo_capture_session()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.serialize_bulk_photo_item_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.photo_capture_sessions;
BEGIN
  SELECT * INTO target
  FROM public.photo_capture_sessions
  WHERE id = NEW.session_id
  FOR UPDATE;

  IF target.id IS NULL
    OR target.status <> 'in_progress'
    OR NOT private.current_user_can_mutate_capture_session(target.id)
  THEN
    RAISE EXCEPTION 'Capture session is no longer accepting photos.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER serialize_bulk_photo_item_insert
BEFORE INSERT ON public.bulk_photo_items
FOR EACH ROW EXECUTE FUNCTION private.serialize_bulk_photo_item_insert();

REVOKE ALL ON FUNCTION private.serialize_bulk_photo_item_insert()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX photos_capture_session_idx
  ON public.photos (capture_session_id, sort_order)
  WHERE capture_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION private.capture_session_vehicle_matches_dealership(
  _vehicle_id uuid,
  _dealership_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT _vehicle_id IS NULL OR EXISTS (
    SELECT 1 FROM public.vehicles AS v
    WHERE v.id = _vehicle_id AND v.dealership_id = _dealership_id
  );
$$;

CREATE OR REPLACE FUNCTION private.current_user_can_view_capture_session(_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.photo_capture_sessions AS s
    WHERE s.id = _session_id
      AND private.current_user_has_active_membership(s.dealership_id)
      AND (
        s.created_by = (SELECT auth.uid())
        OR private.current_user_is_dealership_admin(s.dealership_id)
      )
  );
$$;

CREATE OR REPLACE FUNCTION private.current_user_can_mutate_capture_session(_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.photo_capture_sessions AS s
    WHERE s.id = _session_id
      AND private.current_user_has_active_membership(s.dealership_id)
      AND (
        (s.status = 'in_progress' AND s.created_by = (SELECT auth.uid()))
        OR (
          s.status IN ('in_progress', 'completed')
          AND private.current_user_is_dealership_admin(s.dealership_id)
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION private.current_user_can_access_capture_session_text(_session_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN private.current_user_can_mutate_capture_session(_session_id::uuid)
    OR EXISTS (
      SELECT 1
      FROM public.photo_capture_sessions AS s
      WHERE s.id = _session_id::uuid
        AND s.status = 'prepared'
        AND s.vehicle_id IS NOT NULL
        AND private.current_user_can_access_vehicle(s.vehicle_id)
    );
EXCEPTION WHEN invalid_text_representation THEN
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION private.capture_session_vehicle_matches_dealership(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_can_view_capture_session(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_can_mutate_capture_session(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_can_access_capture_session_text(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.capture_session_vehicle_matches_dealership(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_can_view_capture_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_can_mutate_capture_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_can_access_capture_session_text(text) TO authenticated;

ALTER TABLE public.photo_capture_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bulk_photo_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.photo_capture_sessions, public.bulk_photo_items FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON public.photos FROM authenticated;
GRANT UPDATE (
  image_url, shot_type, overlay_id, sort_order, is_main, is_cutout,
  cutout_status, cutout_image_url, corrected_cutout_url, photo_state
) ON public.photos TO authenticated;
GRANT SELECT, INSERT ON public.photo_capture_sessions TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.bulk_photo_items TO authenticated;
GRANT UPDATE (shot_type, sort_order, is_main) ON public.bulk_photo_items TO authenticated;
GRANT ALL ON public.photo_capture_sessions, public.bulk_photo_items TO service_role;

CREATE POLICY "Authorized users view capture sessions"
ON public.photo_capture_sessions FOR SELECT TO authenticated
USING (private.current_user_can_view_capture_session(id));

CREATE POLICY "Active members create capture sessions"
ON public.photo_capture_sessions FOR INSERT TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND status = 'in_progress'
  AND completed_by IS NULL AND completed_at IS NULL
  AND prepared_by IS NULL AND prepared_at IS NULL
  AND private.current_user_has_active_membership(dealership_id)
  AND private.capture_session_vehicle_matches_dealership(vehicle_id, dealership_id)
);

CREATE POLICY "Authorized users view bulk photo items"
ON public.bulk_photo_items FOR SELECT TO authenticated
USING (private.current_user_can_view_capture_session(session_id));

CREATE POLICY "Authorized users insert bulk photo items"
ON public.bulk_photo_items FOR INSERT TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND photo_id IS NULL
  AND private.current_user_can_mutate_capture_session(session_id)
);

CREATE POLICY "Authorized users update bulk photo items"
ON public.bulk_photo_items FOR UPDATE TO authenticated
USING (private.current_user_can_mutate_capture_session(session_id))
WITH CHECK (
  private.current_user_can_mutate_capture_session(session_id)
);

CREATE POLICY "Authorized users delete bulk photo items"
ON public.bulk_photo_items FOR DELETE TO authenticated
USING (private.current_user_can_mutate_capture_session(session_id));

CREATE OR REPLACE FUNCTION public.complete_photo_capture_session(_session_id uuid)
RETURNS public.photo_capture_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.photo_capture_sessions;
  item_count integer;
BEGIN
  SELECT * INTO target
  FROM public.photo_capture_sessions
  WHERE id = _session_id
  FOR UPDATE;

  IF target.id IS NULL
    OR target.status <> 'in_progress'
    OR NOT private.current_user_can_mutate_capture_session(target.id)
  THEN
    RAISE EXCEPTION 'Capture session is unavailable.' USING ERRCODE = '42501';
  END IF;

  SELECT CASE target.mode
    WHEN 'bulk' THEN (SELECT count(*) FROM public.bulk_photo_items WHERE session_id = target.id)
    ELSE (SELECT count(*) FROM public.photos WHERE capture_session_id = target.id)
  END INTO item_count;

  IF item_count < 1 THEN
    RAISE EXCEPTION 'Capture at least one photo before completing this session.'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.photo_capture_sessions
  SET status = 'completed', completed_by = actor_id, completed_at = now(), updated_at = now()
  WHERE id = target.id
  RETURNING * INTO target;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES (
    CASE target.mode WHEN 'bulk' THEN 'bulk_photo_session.completed' ELSE 'photo_session.completed' END,
    actor_id,
    target.dealership_id,
    jsonb_build_object('capture_session_id', target.id, 'vehicle_id', target.vehicle_id, 'photo_count', item_count)
  );

  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.associate_bulk_photo_session(
  _session_id uuid,
  _vehicle_id uuid
)
RETURNS public.photo_capture_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.photo_capture_sessions;
  target_dealership_id uuid;
BEGIN
  SELECT * INTO target
  FROM public.photo_capture_sessions
  WHERE id = _session_id AND mode = 'bulk'
  FOR UPDATE;

  SELECT dealership_id INTO target_dealership_id
  FROM public.vehicles
  WHERE id = _vehicle_id;

  IF target.id IS NULL
    OR target.status <> 'completed'
    OR target_dealership_id IS DISTINCT FROM target.dealership_id
    OR NOT private.current_user_is_dealership_admin(target.dealership_id)
  THEN
    RAISE EXCEPTION 'Bulk photo package cannot be associated.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.photo_capture_sessions
  SET vehicle_id = _vehicle_id, updated_at = now()
  WHERE id = target.id;

  INSERT INTO public.photos (
    vehicle_id, image_url, original_image_url, shot_type, sort_order, is_main,
    capture_session_id, photo_state
  )
  SELECT
    _vehicle_id, item.image_url, item.image_url, item.shot_type, item.sort_order,
    item.is_main AND NOT EXISTS (
      SELECT 1 FROM public.photos AS existing
      WHERE existing.vehicle_id = _vehicle_id AND existing.is_main
    ),
    target.id, 'raw'
  FROM public.bulk_photo_items AS item
  WHERE item.session_id = target.id AND item.photo_id IS NULL
  ORDER BY item.sort_order, item.created_at;

  UPDATE public.bulk_photo_items AS item
  SET photo_id = photo.id
  FROM public.photos AS photo
  WHERE item.session_id = target.id
    AND item.photo_id IS NULL
    AND photo.capture_session_id = target.id
    AND photo.original_image_url = item.image_url;

  UPDATE public.photo_capture_sessions
  SET vehicle_id = _vehicle_id, status = 'prepared', prepared_by = actor_id,
      prepared_at = now(), updated_at = now()
  WHERE id = target.id
  RETURNING * INTO target;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES (
    'bulk_photo_session.associated', actor_id, target.dealership_id,
    jsonb_build_object('capture_session_id', target.id, 'vehicle_id', _vehicle_id)
  );

  RETURN target;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_photo_capture_session(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.associate_bulk_photo_session(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_photo_capture_session(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.associate_bulk_photo_session(uuid, uuid) TO authenticated, service_role;

-- Bulk storage paths begin with the trusted capture session id. Existing
-- vehicle-id paths remain authorized by the original policy branch.
DROP POLICY "Active members insert vehicle photos" ON storage.objects;
DROP POLICY "Active members update vehicle photos" ON storage.objects;
DROP POLICY "Active members delete vehicle photos" ON storage.objects;

CREATE POLICY "Active members insert vehicle photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'vehicle-photos'
  AND (
    private.current_user_can_access_vehicle_text((storage.foldername(name))[1])
    OR private.current_user_can_access_capture_session_text((storage.foldername(name))[1])
  )
);

CREATE POLICY "Active members update vehicle photos"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'vehicle-photos'
  AND (
    private.current_user_can_access_vehicle_text((storage.foldername(name))[1])
    OR private.current_user_can_access_capture_session_text((storage.foldername(name))[1])
  )
)
WITH CHECK (
  bucket_id = 'vehicle-photos'
  AND (
    private.current_user_can_access_vehicle_text((storage.foldername(name))[1])
    OR private.current_user_can_access_capture_session_text((storage.foldername(name))[1])
  )
);

CREATE POLICY "Active members delete vehicle photos"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'vehicle-photos'
  AND (
    private.current_user_can_access_vehicle_text((storage.foldername(name))[1])
    OR private.current_user_can_access_capture_session_text((storage.foldername(name))[1])
  )
);
