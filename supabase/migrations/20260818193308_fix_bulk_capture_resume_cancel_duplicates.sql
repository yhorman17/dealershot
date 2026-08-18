-- Make Bulk Capture resumable, cancelable, and concurrency-safe.

ALTER TABLE public.photo_capture_sessions
  ADD COLUMN canceled_at timestamptz,
  ADD COLUMN canceled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.photo_capture_sessions
  DROP CONSTRAINT photo_capture_sessions_status_check,
  DROP CONSTRAINT photo_capture_sessions_check1,
  DROP CONSTRAINT photo_capture_sessions_check2;

ALTER TABLE public.photo_capture_sessions
  ADD CONSTRAINT photo_capture_sessions_status_check
    CHECK (status IN ('in_progress','completed','prepared','canceled')),
  ADD CONSTRAINT photo_capture_sessions_check1 CHECK (
    (status = 'in_progress' AND completed_at IS NULL AND completed_by IS NULL)
    OR (status IN ('completed','prepared') AND completed_at IS NOT NULL AND completed_by IS NOT NULL)
    OR status = 'canceled'
  ),
  ADD CONSTRAINT photo_capture_sessions_check2 CHECK (
    (status <> 'prepared' AND prepared_at IS NULL AND prepared_by IS NULL)
    OR (status = 'prepared' AND prepared_at IS NOT NULL AND prepared_by IS NOT NULL)
  ),
  ADD CONSTRAINT photo_capture_sessions_cancellation_check CHECK (
    (status = 'canceled' AND canceled_at IS NOT NULL AND canceled_by IS NOT NULL)
    OR (status <> 'canceled' AND canceled_at IS NULL AND canceled_by IS NULL)
  );

-- Reconcile only provably empty duplicate Bulk sessions. Sessions with any
-- persisted item, photo, or ledger asset are deliberately left untouched so a
-- deployment cannot discard real work while establishing the invariant.
WITH active_bulk AS (
  SELECT
    session.id,
    session.dealership_id,
    session.vin,
    session.created_by,
    session.started_at,
    count(DISTINCT item.id) AS item_count,
    count(DISTINCT photo.id) AS photo_count,
    count(DISTINCT asset.id) AS asset_count,
    row_number() OVER (
      PARTITION BY session.dealership_id, session.vin
      ORDER BY session.started_at, session.id
    ) AS sequence
  FROM public.photo_capture_sessions AS session
  LEFT JOIN public.bulk_photo_items AS item ON item.session_id = session.id
  LEFT JOIN public.photos AS photo ON photo.capture_session_id = session.id
  LEFT JOIN public.media_assets AS asset ON asset.capture_session_id = session.id
  WHERE session.mode = 'bulk'
    AND session.status IN ('in_progress','completed','prepared')
    AND session.workflow_stage IN ('capture','review','processing')
  GROUP BY session.id
), safe_duplicate_groups AS (
  SELECT dealership_id, vin
  FROM active_bulk
  GROUP BY dealership_id, vin
  HAVING count(*) > 1
     AND bool_and(created_by IS NOT NULL)
     AND sum(item_count + photo_count + asset_count) = 0
), redundant AS (
  SELECT active.id, active.created_by, active.started_at
  FROM active_bulk AS active
  JOIN safe_duplicate_groups AS duplicate
    ON duplicate.dealership_id = active.dealership_id
   AND duplicate.vin = active.vin
  WHERE active.sequence > 1
)
UPDATE public.photo_capture_sessions AS session
SET status = 'canceled',
    canceled_at = now(),
    canceled_by = redundant.created_by,
    capture_ended_at = coalesce(session.capture_ended_at, now()),
    duration_seconds = greatest(0, extract(epoch FROM (now() - redundant.started_at))::integer),
    notes = concat_ws(E'\n', nullif(session.notes, ''),
      'Canceled automatically: redundant empty Bulk Capture workflow.'),
    updated_at = now()
FROM redundant
WHERE session.id = redundant.id;

CREATE UNIQUE INDEX photo_capture_sessions_one_active_bulk_vin_idx
  ON public.photo_capture_sessions (dealership_id, vin)
  WHERE mode = 'bulk'
    AND status IN ('in_progress','completed','prepared')
    AND workflow_stage IN ('capture','review','processing');

CREATE UNIQUE INDEX photo_capture_sessions_one_active_bulk_vehicle_idx
  ON public.photo_capture_sessions (dealership_id, vehicle_id)
  WHERE mode = 'bulk'
    AND vehicle_id IS NOT NULL
    AND status IN ('in_progress','completed','prepared')
    AND workflow_stage IN ('capture','review','processing');

CREATE OR REPLACE FUNCTION public.start_photo_capture_session(
  _dealership_id uuid,
  _vehicle_id uuid DEFAULT NULL,
  _vin text DEFAULT NULL,
  _mode text DEFAULT 'guided'
)
RETURNS public.photo_capture_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.photo_capture_sessions;
  vehicle_store_id uuid;
  vehicle_vin text;
  normalized_vin text := upper(btrim(_vin));
BEGIN
  IF actor_id IS NULL OR _mode NOT IN ('guided','bulk')
     OR NOT private.current_user_has_active_membership(_dealership_id)
     OR NOT (
       private.current_user_has_store_capability(_dealership_id,'capture')
       OR private.current_user_has_store_capability(_dealership_id,'media')
     )
     OR NOT private.capture_method_enabled(_dealership_id,_mode) THEN
    RAISE EXCEPTION 'This capture method is unavailable.' USING ERRCODE='42501';
  END IF;

  IF _vehicle_id IS NOT NULL THEN
    SELECT dealership_id,vin INTO vehicle_store_id,vehicle_vin
    FROM public.vehicles WHERE id=_vehicle_id;
    IF vehicle_store_id IS DISTINCT FROM _dealership_id THEN
      RAISE EXCEPTION 'Capture session is unavailable.' USING ERRCODE='42501';
    END IF;
    normalized_vin := upper(btrim(vehicle_vin));
  ELSIF _mode='guided' THEN
    RAISE EXCEPTION 'Guided capture requires a vehicle.' USING ERRCODE='42501';
  END IF;

  IF _mode='bulk' AND (normalized_vin IS NULL OR normalized_vin !~ '^[A-HJ-NPR-Z0-9]{8,17}$') THEN
    RAISE EXCEPTION 'Enter a valid VIN before starting Bulk Capture.' USING ERRCODE='22023';
  ELSIF _mode='guided' AND normalized_vin IS NOT NULL
        AND normalized_vin !~ '^[A-HJ-NPR-Z0-9]{8,17}$' THEN
    normalized_vin := NULL;
  END IF;

  IF _mode='bulk' THEN
    -- Serialize all starts for the same store/VIN before checking or inserting.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(_dealership_id::text || ':bulk:' || normalized_vin, 0)
    );
    SELECT session.* INTO target
    FROM public.photo_capture_sessions AS session
    WHERE session.dealership_id=_dealership_id
      AND session.mode='bulk'
      AND session.status IN ('in_progress','completed','prepared')
      AND session.workflow_stage IN ('capture','review','processing')
      AND (session.vin=normalized_vin OR (_vehicle_id IS NOT NULL AND session.vehicle_id=_vehicle_id))
    ORDER BY session.started_at
    LIMIT 1
    FOR UPDATE;
    IF target.id IS NOT NULL THEN RETURN target; END IF;
  END IF;

  INSERT INTO public.photo_capture_sessions (
    dealership_id,vehicle_id,vin,mode,status,created_by,workflow_stage
  ) VALUES (
    _dealership_id,_vehicle_id,nullif(normalized_vin,''),_mode,'in_progress',actor_id,'capture'
  )
  ON CONFLICT DO NOTHING RETURNING * INTO target;

  IF target.id IS NULL AND _mode='guided' THEN
    SELECT session.* INTO target FROM public.photo_capture_sessions AS session
    WHERE session.vehicle_id=_vehicle_id AND session.created_by=actor_id
      AND session.mode='guided' AND session.status='in_progress' LIMIT 1;
  ELSIF target.id IS NULL AND _mode='bulk' THEN
    SELECT session.* INTO target FROM public.photo_capture_sessions AS session
    WHERE session.dealership_id=_dealership_id AND session.mode='bulk'
      AND session.status IN ('in_progress','completed','prepared')
      AND session.workflow_stage IN ('capture','review','processing')
      AND (session.vin=normalized_vin OR (_vehicle_id IS NOT NULL AND session.vehicle_id=_vehicle_id))
    ORDER BY session.started_at LIMIT 1;
  END IF;
  IF target.id IS NULL THEN
    RAISE EXCEPTION 'Capture session could not be started.' USING ERRCODE='23505';
  END IF;
  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_bulk_capture_workflow(_session_id uuid)
RETURNS public.photo_capture_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.photo_capture_sessions;
BEGIN
  SELECT * INTO target FROM public.photo_capture_sessions
  WHERE id=_session_id FOR UPDATE;

  IF target.id IS NULL OR target.mode<>'bulk'
     OR actor_id IS NULL
     OR NOT private.current_user_has_active_membership(target.dealership_id)
     OR NOT (
       private.current_user_has_store_capability(target.dealership_id,'media')
       OR (target.created_by=actor_id
           AND private.current_user_has_store_capability(target.dealership_id,'capture'))
     ) THEN
    RAISE EXCEPTION 'Bulk Capture workflow is unavailable.' USING ERRCODE='42501';
  END IF;

  IF target.status='canceled' THEN RETURN target; END IF;
  IF target.status<>'in_progress' OR target.workflow_stage NOT IN ('capture','review') THEN
    RAISE EXCEPTION 'Completed photo work cannot be canceled.' USING ERRCODE='55000';
  END IF;

  UPDATE public.photo_capture_sessions
  SET status='canceled',
      canceled_at=now(),
      canceled_by=actor_id,
      capture_ended_at=coalesce(capture_ended_at,now()),
      duration_seconds=greatest(0,
        extract(epoch FROM (coalesce(capture_ended_at,now())-started_at))::integer),
      updated_at=now()
  WHERE id=target.id
  RETURNING * INTO target;

  INSERT INTO public.audit_events (event_type,actor_profile_id,dealership_id,payload)
  VALUES ('bulk_photo_session.canceled',actor_id,target.dealership_id,
    jsonb_build_object('capture_session_id',target.id,'vehicle_id',target.vehicle_id,
      'vin',target.vin,'photo_count',(
        SELECT count(*) FROM public.bulk_photo_items WHERE session_id=target.id
      ),'duration_seconds',target.duration_seconds));

  RETURN target;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_bulk_capture_workflow(uuid)
FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.cancel_bulk_capture_workflow(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.start_photo_capture_session(uuid,uuid,text,text)
FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.start_photo_capture_session(uuid,uuid,text,text)
TO authenticated;
