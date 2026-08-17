-- Store-scoped operational configuration, atomic gallery mutations, document
-- freshness, and accounting controls for hosted DealerShot acceptance.

CREATE TABLE public.photography_settings (
  dealership_id uuid PRIMARY KEY REFERENCES public.dealerships(id) ON DELETE CASCADE,
  completion_policy text NOT NULL DEFAULT 'warn'
    CHECK (completion_policy IN ('block', 'warn')),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.photo_shot_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  shot_key text NOT NULL CHECK (shot_key ~ '^[a-z][a-z0-9_-]{1,79}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  guidance text CHECK (guidance IS NULL OR length(guidance) <= 500),
  category text NOT NULL
    CHECK (category IN ('exterior','interior','detail','odometer','vin')),
  required boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  minimum_count smallint NOT NULL DEFAULT 1 CHECK (minimum_count BETWEEN 1 AND 20),
  applies_to text[] NOT NULL DEFAULT ARRAY['new','used','certified']::text[],
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dealership_id, shot_key),
  CHECK (applies_to <@ ARRAY['new','used','certified']::text[])
);

CREATE INDEX photo_shot_requirements_store_order_idx
  ON public.photo_shot_requirements (dealership_id, enabled, category, sort_order);

INSERT INTO public.photography_settings (dealership_id)
SELECT id FROM public.dealerships
ON CONFLICT (dealership_id) DO NOTHING;

INSERT INTO public.photo_shot_requirements
  (dealership_id, shot_key, label, guidance, category, required, enabled, sort_order)
SELECT d.id, seed.shot_key, seed.label, seed.guidance, seed.category, seed.required, true,
       seed.sort_order
FROM public.dealerships AS d
CROSS JOIN (VALUES
  ('front_3q_driver', 'Front 3/4 · driver', 'Show the grille and driver side with the full vehicle in frame.', 'exterior', true, 10),
  ('front', 'Front', 'Center the vehicle and keep the complete front bumper visible.', 'exterior', true, 20),
  ('driver_side', 'Driver side', 'Capture the full side profile at door-handle height.', 'exterior', true, 30),
  ('rear_3q_driver', 'Rear 3/4 · driver', 'Show the rear and driver side with the full vehicle in frame.', 'exterior', true, 40),
  ('rear', 'Rear', 'Center the vehicle and keep the complete rear bumper visible.', 'exterior', true, 50),
  ('rear_3q_passenger', 'Rear 3/4 · passenger', 'Show the rear and passenger side with the full vehicle in frame.', 'exterior', true, 60),
  ('passenger_side', 'Passenger side', 'Capture the full side profile at door-handle height.', 'exterior', true, 70),
  ('front_3q_passenger', 'Front 3/4 · passenger', 'Show the grille and passenger side with the full vehicle in frame.', 'exterior', true, 80),
  ('dashboard', 'Dashboard', 'Capture the dashboard straight on with the steering wheel visible.', 'interior', false, 110),
  ('front_seats', 'Front seats', 'Show both front seats and their condition.', 'interior', false, 120),
  ('rear_seats', 'Rear seats', 'Show the complete rear seating area.', 'interior', false, 130),
  ('cargo', 'Cargo', 'Open the cargo area and show its usable space.', 'interior', false, 140),
  ('odometer', 'Odometer', 'Keep the mileage display sharp and readable.', 'odometer', false, 160)
) AS seed(shot_key, label, guidance, category, required, sort_order)
ON CONFLICT (dealership_id, shot_key) DO NOTHING;

ALTER TABLE public.photo_capture_sessions
  ADD COLUMN requirements_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(requirements_snapshot) = 'array'
      AND octet_length(requirements_snapshot::text) <= 131072),
  ADD COLUMN completion_policy text NOT NULL DEFAULT 'warn'
    CHECK (completion_policy IN ('block', 'warn')),
  ADD COLUMN missing_requirements jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(missing_requirements) = 'array'
      AND octet_length(missing_requirements::text) <= 131072);

CREATE OR REPLACE FUNCTION private.capture_requirement_snapshot(
  _dealership_id uuid,
  _vehicle_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'shot_key', requirement.shot_key,
    'label', requirement.label,
    'guidance', requirement.guidance,
    'category', requirement.category,
    'required', requirement.required,
    'minimum_count', requirement.minimum_count,
    'sort_order', requirement.sort_order
  ) ORDER BY requirement.sort_order, requirement.label), '[]'::jsonb)
  FROM public.photo_shot_requirements AS requirement
  WHERE requirement.dealership_id = _dealership_id
    AND requirement.enabled
    AND (
      _vehicle_id IS NULL
      OR coalesce((SELECT inventory_type FROM public.vehicles WHERE id = _vehicle_id), 'used')
         = ANY (requirement.applies_to)
    );
$$;

CREATE OR REPLACE FUNCTION private.snapshot_capture_configuration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.mode = 'bulk' THEN
    -- Bulk intake is intentionally unordered. Required labels are assigned in
    -- the office workspace after the raw package is safely completed.
    NEW.requirements_snapshot := '[]'::jsonb;
    NEW.completion_policy := 'warn';
  ELSE
    NEW.requirements_snapshot := private.capture_requirement_snapshot(
      NEW.dealership_id, NEW.vehicle_id
    );
    SELECT coalesce(settings.completion_policy, 'warn') INTO NEW.completion_policy
    FROM public.photography_settings AS settings
    WHERE settings.dealership_id = NEW.dealership_id;
  END IF;
  NEW.completion_policy := coalesce(NEW.completion_policy, 'warn');
  NEW.missing_requirements := '[]'::jsonb;
  RETURN NEW;
END;
$$;

CREATE TRIGGER photo_capture_sessions_snapshot_configuration
BEFORE INSERT ON public.photo_capture_sessions
FOR EACH ROW EXECUTE FUNCTION private.snapshot_capture_configuration();

UPDATE public.photo_capture_sessions AS session
SET requirements_snapshot = private.capture_requirement_snapshot(
      session.dealership_id, session.vehicle_id
    ),
    completion_policy = coalesce(settings.completion_policy, 'warn')
FROM public.photography_settings AS settings
WHERE settings.dealership_id = session.dealership_id
  AND session.mode = 'guided'
  AND session.requirements_snapshot = '[]'::jsonb;

CREATE OR REPLACE FUNCTION private.capture_session_missing_requirements(_session_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH session AS (
    SELECT * FROM public.photo_capture_sessions WHERE id = _session_id
  ), requirements AS (
    SELECT requirement
    FROM session,
      jsonb_array_elements(session.requirements_snapshot) AS requirement
    WHERE coalesce((requirement->>'required')::boolean, false)
  ), captured AS (
    SELECT lower(btrim(coalesce(item.shot_type, ''))) AS label, count(*)::integer AS count
    FROM session
    JOIN public.bulk_photo_items AS item ON session.mode = 'bulk' AND item.session_id = session.id
    GROUP BY lower(btrim(coalesce(item.shot_type, '')))
    UNION ALL
    SELECT lower(btrim(coalesce(photo.shot_type, ''))) AS label, count(*)::integer AS count
    FROM session
    JOIN public.photos AS photo ON session.mode <> 'bulk' AND photo.capture_session_id = session.id
    GROUP BY lower(btrim(coalesce(photo.shot_type, '')))
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'shot_key', requirement->>'shot_key',
    'label', requirement->>'label',
    'category', requirement->>'category',
    'minimum_count', coalesce((requirement->>'minimum_count')::integer, 1),
    'captured_count', coalesce((
      SELECT sum(captured.count) FROM captured
      WHERE captured.label = lower(btrim(requirement->>'label'))
    ), 0)
  ) ORDER BY coalesce((requirement->>'sort_order')::integer, 0)), '[]'::jsonb)
  FROM requirements
  WHERE coalesce((
    SELECT sum(captured.count) FROM captured
    WHERE captured.label = lower(btrim(requirement->>'label'))
  ), 0) < coalesce((requirement->>'minimum_count')::integer, 1);
$$;

REVOKE ALL ON FUNCTION private.capture_requirement_snapshot(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.snapshot_capture_configuration()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.capture_session_missing_requirements(uuid)
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.seed_dealership_photo_configuration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.photography_settings (dealership_id)
  VALUES (NEW.id)
  ON CONFLICT (dealership_id) DO NOTHING;

  INSERT INTO public.photo_shot_requirements
    (dealership_id, shot_key, label, guidance, category, required, enabled, sort_order)
  SELECT NEW.id, seed.shot_key, seed.label, seed.guidance, seed.category,
         seed.required, true, seed.sort_order
  FROM (VALUES
    ('front_3q_driver', 'Front 3/4 · driver', 'Show the grille and driver side with the full vehicle in frame.', 'exterior', true, 10),
    ('front', 'Front', 'Center the vehicle and keep the complete front bumper visible.', 'exterior', true, 20),
    ('driver_side', 'Driver side', 'Capture the full side profile at door-handle height.', 'exterior', true, 30),
    ('rear_3q_driver', 'Rear 3/4 · driver', 'Show the rear and driver side with the full vehicle in frame.', 'exterior', true, 40),
    ('rear', 'Rear', 'Center the vehicle and keep the complete rear bumper visible.', 'exterior', true, 50),
    ('rear_3q_passenger', 'Rear 3/4 · passenger', 'Show the rear and passenger side with the full vehicle in frame.', 'exterior', true, 60),
    ('passenger_side', 'Passenger side', 'Capture the full side profile at door-handle height.', 'exterior', true, 70),
    ('front_3q_passenger', 'Front 3/4 · passenger', 'Show the grille and passenger side with the full vehicle in frame.', 'exterior', true, 80),
    ('dashboard', 'Dashboard', 'Capture the dashboard straight on with the steering wheel visible.', 'interior', false, 110),
    ('front_seats', 'Front seats', 'Show both front seats and their condition.', 'interior', false, 120),
    ('rear_seats', 'Rear seats', 'Show the complete rear seating area.', 'interior', false, 130),
    ('cargo', 'Cargo', 'Open the cargo area and show its usable space.', 'interior', false, 140),
    ('odometer', 'Odometer', 'Keep the mileage display sharp and readable.', 'odometer', false, 160)
  ) AS seed(shot_key, label, guidance, category, required, sort_order)
  ON CONFLICT (dealership_id, shot_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dealerships_seed_photo_configuration
AFTER INSERT ON public.dealerships
FOR EACH ROW EXECUTE FUNCTION private.seed_dealership_photo_configuration();

REVOKE ALL ON FUNCTION private.seed_dealership_photo_configuration()
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_readiness_configuration(
  _dealership_id uuid,
  _rules jsonb
)
RETURNS SETOF public.readiness_rules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  item jsonb;
  allowed_keys constant text[] := ARRAY[
    'vehicle.vin','vehicle.stock_number','vehicle.price','vehicle.comments',
    'vehicle.specifications','media.minimum_photos','media.odometer','media.vin',
    'media.video','media.exterior_360','media.interior_360',
    'processing.completed','processing.review_approved','processing.no_failures'
  ];
  key_value text;
  applies text[];
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'settings') THEN
    RAISE EXCEPTION 'Retail Ready settings are unavailable.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(_rules) <> 'array' OR jsonb_array_length(_rules) > 30 THEN
    RAISE EXCEPTION 'Readiness rules must be a bounded array.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.dealerships WHERE id = _dealership_id FOR UPDATE;
  FOR item IN SELECT value FROM jsonb_array_elements(_rules)
  LOOP
    key_value := item->>'key';
    IF key_value IS NULL OR NOT key_value = ANY (allowed_keys)
       OR jsonb_typeof(item->'enabled') <> 'boolean'
       OR jsonb_typeof(item->'applies_to') <> 'array' THEN
      RAISE EXCEPTION 'A readiness rule is invalid.' USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(value ORDER BY value) INTO applies
    FROM jsonb_array_elements_text(item->'applies_to');
    IF coalesce(cardinality(applies), 0) = 0
       OR NOT (applies <@ ARRAY['new','used','certified']::text[]) THEN
      RAISE EXCEPTION 'A readiness vehicle scope is invalid.' USING ERRCODE = '22023';
    END IF;
    IF key_value = 'media.minimum_photos'
       AND (coalesce((item->'config'->>'minimum')::integer, 0) < 0
            OR coalesce((item->'config'->>'minimum')::integer, 0) > 200) THEN
      RAISE EXCEPTION 'Minimum photos must be between 0 and 200.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.readiness_rules
      (dealership_id, rule_key, label, severity, applies_to, config, enabled,
       sort_order, updated_at)
    VALUES (
      _dealership_id, key_value,
      left(coalesce(nullif(btrim(item->>'label'), ''), initcap(replace(key_value, '.', ' '))), 160),
      CASE WHEN item->>'severity' = 'blocked' THEN 'blocked' ELSE 'attention' END,
      applies, coalesce(item->'config', '{}'::jsonb), (item->>'enabled')::boolean,
      greatest(0, coalesce((item->>'sort_order')::integer, 0)), now()
    )
    ON CONFLICT (dealership_id, rule_key) DO UPDATE
    SET label = EXCLUDED.label, severity = EXCLUDED.severity,
        applies_to = EXCLUDED.applies_to, config = EXCLUDED.config,
        enabled = EXCLUDED.enabled, sort_order = EXCLUDED.sort_order,
        updated_at = now();
  END LOOP;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('configuration.readiness_changed', actor_id, _dealership_id,
          jsonb_build_object('rule_count', jsonb_array_length(_rules)));
  PERFORM private.evaluate_vehicle_readiness(vehicle.id)
  FROM public.vehicles AS vehicle WHERE vehicle.dealership_id = _dealership_id;
  RETURN QUERY SELECT * FROM public.readiness_rules
    WHERE dealership_id = _dealership_id ORDER BY sort_order, rule_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_photography_configuration(
  _dealership_id uuid,
  _completion_policy text,
  _shots jsonb
)
RETURNS SETOF public.photo_shot_requirements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  item jsonb;
  seen_keys text[] := ARRAY[]::text[];
  key_value text;
  applies text[];
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'settings') THEN
    RAISE EXCEPTION 'Photography settings are unavailable.' USING ERRCODE = '42501';
  END IF;
  IF _completion_policy NOT IN ('block','warn')
     OR jsonb_typeof(_shots) <> 'array' OR jsonb_array_length(_shots) > 100 THEN
    RAISE EXCEPTION 'Photography configuration is invalid.' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.dealerships WHERE id = _dealership_id FOR UPDATE;

  FOR item IN SELECT value FROM jsonb_array_elements(_shots)
  LOOP
    key_value := lower(btrim(item->>'shot_key'));
    IF key_value IS NULL OR key_value !~ '^[a-z][a-z0-9_-]{1,79}$'
       OR key_value = ANY (seen_keys)
       OR nullif(btrim(item->>'label'), '') IS NULL
       OR item->>'category' NOT IN ('exterior','interior','detail','odometer','vin')
       OR jsonb_typeof(item->'required') <> 'boolean'
       OR jsonb_typeof(item->'enabled') <> 'boolean'
       OR jsonb_typeof(item->'applies_to') <> 'array' THEN
      RAISE EXCEPTION 'A photography requirement is invalid.' USING ERRCODE = '22023';
    END IF;
    seen_keys := array_append(seen_keys, key_value);
    SELECT array_agg(value ORDER BY value) INTO applies
    FROM jsonb_array_elements_text(item->'applies_to');
    IF coalesce(cardinality(applies), 0) = 0
       OR NOT (applies <@ ARRAY['new','used','certified']::text[]) THEN
      RAISE EXCEPTION 'A photography vehicle scope is invalid.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.photo_shot_requirements
      (dealership_id, shot_key, label, guidance, category, required, enabled,
       minimum_count, applies_to, sort_order, updated_at)
    VALUES (
      _dealership_id, key_value, left(btrim(item->>'label'), 120),
      nullif(left(btrim(coalesce(item->>'guidance', '')), 500), ''), item->>'category',
      (item->>'required')::boolean, (item->>'enabled')::boolean,
      greatest(1, least(20, coalesce((item->>'minimum_count')::integer, 1))),
      applies, greatest(0, coalesce((item->>'sort_order')::integer, 0)), now()
    )
    ON CONFLICT (dealership_id, shot_key) DO UPDATE
    SET label = EXCLUDED.label, guidance = EXCLUDED.guidance,
        category = EXCLUDED.category, required = EXCLUDED.required,
        enabled = EXCLUDED.enabled, minimum_count = EXCLUDED.minimum_count,
        applies_to = EXCLUDED.applies_to, sort_order = EXCLUDED.sort_order,
        updated_at = now();
  END LOOP;

  UPDATE public.photo_shot_requirements
  SET enabled = false, updated_at = now()
  WHERE dealership_id = _dealership_id
    AND NOT (shot_key = ANY (seen_keys));
  INSERT INTO public.photography_settings
    (dealership_id, completion_policy, updated_by, updated_at)
  VALUES (_dealership_id, _completion_policy, actor_id, now())
  ON CONFLICT (dealership_id) DO UPDATE
  SET completion_policy = EXCLUDED.completion_policy,
      updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('configuration.photography_changed', actor_id, _dealership_id,
          jsonb_build_object('shot_count', jsonb_array_length(_shots),
                             'completion_policy', _completion_policy));
  PERFORM private.evaluate_vehicle_readiness(vehicle.id)
  FROM public.vehicles AS vehicle WHERE vehicle.dealership_id = _dealership_id;
  RETURN QUERY SELECT * FROM public.photo_shot_requirements
    WHERE dealership_id = _dealership_id ORDER BY sort_order, label;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_media_processing_configuration(
  _dealership_id uuid,
  _rules jsonb
)
RETURNS SETOF public.media_processing_rules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  item jsonb;
  category_value text;
  action_value text;
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'settings') THEN
    RAISE EXCEPTION 'Media processing settings are unavailable.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(_rules) <> 'array' OR jsonb_array_length(_rules) > 20 THEN
    RAISE EXCEPTION 'Media processing rules must be a bounded array.' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.dealerships WHERE id = _dealership_id FOR UPDATE;
  FOR item IN SELECT value FROM jsonb_array_elements(_rules)
  LOOP
    category_value := item->>'media_category';
    action_value := item->>'action';
    IF category_value NOT IN ('exterior','interior','detail','odometer','vin','document','misc')
       OR action_value NOT IN ('keep_original','manual_review')
       OR jsonb_typeof(item->'enabled') <> 'boolean' THEN
      RAISE EXCEPTION 'Only currently operational processing modes may be selected.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.media_processing_rules
      (dealership_id, media_category, action, enabled, priority, config, updated_at)
    VALUES (_dealership_id, category_value, action_value, (item->>'enabled')::boolean,
            greatest(-100, least(100, coalesce((item->>'priority')::integer, 0))),
            coalesce(item->'config', '{}'::jsonb), now())
    ON CONFLICT (dealership_id, media_category) DO UPDATE
    SET action = EXCLUDED.action, enabled = EXCLUDED.enabled,
        priority = EXCLUDED.priority, config = EXCLUDED.config, updated_at = now();
  END LOOP;
  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('configuration.media_processing_changed', actor_id, _dealership_id,
          jsonb_build_object('rule_count', jsonb_array_length(_rules),
                             'existing_media_reprocessed', false));
  RETURN QUERY SELECT * FROM public.media_processing_rules
    WHERE dealership_id = _dealership_id ORDER BY media_category;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_document_requirements(
  _dealership_id uuid,
  _requirements jsonb
)
RETURNS SETOF public.document_requirements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  item jsonb;
  document_type_value text;
  applies text[];
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'settings') THEN
    RAISE EXCEPTION 'Document settings are unavailable.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(_requirements) <> 'array' OR jsonb_array_length(_requirements) > 10 THEN
    RAISE EXCEPTION 'Document requirements must be a bounded array.' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.dealerships WHERE id = _dealership_id FOR UPDATE;
  FOR item IN SELECT value FROM jsonb_array_elements(_requirements)
  LOOP
    document_type_value := item->>'document_type';
    IF document_type_value NOT IN ('window_sticker','buyers_guide','addendum','cpo_sheet','placard')
       OR jsonb_typeof(item->'enabled') <> 'boolean'
       OR jsonb_typeof(item->'required') <> 'boolean'
       OR jsonb_typeof(item->'applies_to') <> 'array' THEN
      RAISE EXCEPTION 'A document requirement is invalid.' USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(value ORDER BY value) INTO applies
    FROM jsonb_array_elements_text(item->'applies_to');
    IF coalesce(cardinality(applies), 0) = 0
       OR NOT (applies <@ ARRAY['new','used','certified']::text[]) THEN
      RAISE EXCEPTION 'A document vehicle scope is invalid.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.document_requirements
      (dealership_id, document_type, applies_to, required, enabled, updated_by, updated_at)
    VALUES (_dealership_id, document_type_value, applies,
            (item->>'required')::boolean, (item->>'enabled')::boolean, actor_id, now())
    ON CONFLICT (dealership_id, document_type) DO UPDATE
    SET applies_to = EXCLUDED.applies_to, required = EXCLUDED.required,
        enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now();
  END LOOP;
  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('configuration.documents_changed', actor_id, _dealership_id,
          jsonb_build_object('requirement_count', jsonb_array_length(_requirements)));
  PERFORM private.evaluate_vehicle_readiness(vehicle.id)
  FROM public.vehicles AS vehicle WHERE vehicle.dealership_id = _dealership_id;
  RETURN QUERY SELECT * FROM public.document_requirements
    WHERE dealership_id = _dealership_id ORDER BY document_type;
END;
$$;

ALTER TABLE public.generated_documents
  ADD COLUMN source_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN stale_at timestamptz,
  ADD COLUMN stale_reason text CHECK (stale_reason IS NULL OR length(stale_reason) <= 160);

CREATE INDEX generated_documents_stale_idx
  ON public.generated_documents (dealership_id, stale_at, generated_at DESC)
  WHERE status = 'generated';

CREATE OR REPLACE FUNCTION private.mark_vehicle_documents_stale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_vehicle_id uuid;
  reason text;
BEGIN
  IF TG_TABLE_NAME = 'vehicles' THEN
    target_vehicle_id := NEW.id;
    reason := 'Vehicle information changed';
  ELSIF TG_TABLE_NAME = 'dealerships' THEN
    UPDATE public.generated_documents
    SET stale_at = coalesce(stale_at, now()), stale_reason = 'Dealership information changed',
        updated_at = now()
    WHERE dealership_id = NEW.id AND status = 'generated';
    RETURN NEW;
  ELSE
    target_vehicle_id := coalesce(NEW.vehicle_id, OLD.vehicle_id);
    reason := CASE TG_TABLE_NAME
      WHEN 'vehicle_equipment' THEN 'Vehicle equipment changed'
      ELSE 'Vehicle warranty changed'
    END;
  END IF;

  UPDATE public.generated_documents
  SET stale_at = coalesce(stale_at, now()), stale_reason = reason, updated_at = now()
  WHERE vehicle_id = target_vehicle_id AND status = 'generated';
  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE TRIGGER vehicles_mark_documents_stale
AFTER UPDATE OF vin, stock_number, year, make, model, trim, series, body_class,
  inventory_type, certification_program, odometer, exterior_color, interior_color,
  engine, transmission, drivetrain, fuel_type, warranty_type, price, msrp,
  internet_price, sale_price, price_description, comments, custom_comments,
  tagline, publication_description
ON public.vehicles FOR EACH ROW EXECUTE FUNCTION private.mark_vehicle_documents_stale();

CREATE TRIGGER vehicle_equipment_mark_documents_stale
AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_equipment
FOR EACH ROW EXECUTE FUNCTION private.mark_vehicle_documents_stale();

CREATE TRIGGER vehicle_warranties_mark_documents_stale
AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_warranties
FOR EACH ROW EXECUTE FUNCTION private.mark_vehicle_documents_stale();

CREATE TRIGGER dealerships_mark_documents_stale
AFTER UPDATE OF name, address, phone, website, logo_url, branding
ON public.dealerships FOR EACH ROW EXECUTE FUNCTION private.mark_vehicle_documents_stale();

REVOKE ALL ON FUNCTION private.mark_vehicle_documents_stale()
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.evaluate_vehicle_readiness(_vehicle_id uuid)
RETURNS public.vehicle_readiness
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.vehicles;
  rule public.readiness_rules;
  requirement public.document_requirements;
  shot_requirement public.photo_shot_requirements;
  reason_list jsonb := '[]'::jsonb;
  photo_total integer := 0;
  video_total integer := 0;
  document_total integer := 0;
  equipment_total integer := 0;
  minimum_required integer;
  matching_count integer;
  has_failed_processing boolean := false;
  has_active_processing boolean := false;
  has_pending_review boolean := false;
  failures_block boolean := false;
  processing_required boolean := false;
  approval_required boolean := false;
  next_status text := 'retail_ready';
  result public.vehicle_readiness;
BEGIN
  SELECT * INTO target FROM public.vehicles WHERE id = _vehicle_id;
  IF target.id IS NULL THEN
    RAISE EXCEPTION 'Vehicle not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) FILTER (WHERE media_kind = 'photo'),
         count(*) FILTER (WHERE media_kind = 'video'),
         coalesce(bool_or(processing_status = 'failed'), false),
         coalesce(bool_or(processing_status IN ('queued','processing')), false),
         coalesce(bool_or(review_status = 'awaiting_review'), false)
  INTO photo_total, video_total, has_failed_processing, has_active_processing, has_pending_review
  FROM public.photos WHERE vehicle_id = target.id;
  SELECT count(*) INTO equipment_total
  FROM public.vehicle_equipment WHERE vehicle_id = target.id;
  SELECT count(*) INTO document_total
  FROM public.generated_documents
  WHERE vehicle_id = target.id AND status = 'generated' AND stale_at IS NULL;

  FOR rule IN
    SELECT * FROM public.readiness_rules
    WHERE dealership_id = target.dealership_id AND enabled
      AND coalesce(target.inventory_type, 'used') = ANY (applies_to)
    ORDER BY sort_order, rule_key
  LOOP
    matching_count := 1;
    IF rule.rule_key = 'vehicle.vin' THEN
      matching_count := CASE WHEN nullif(btrim(target.vin), '') IS NULL THEN 0 ELSE 1 END;
    ELSIF rule.rule_key = 'vehicle.stock_number' THEN
      matching_count := CASE WHEN nullif(btrim(target.stock_number), '') IS NULL THEN 0 ELSE 1 END;
    ELSIF rule.rule_key = 'vehicle.price' THEN
      matching_count := CASE WHEN coalesce(target.sale_price, target.internet_price, target.price, target.msrp) IS NULL THEN 0 ELSE 1 END;
    ELSIF rule.rule_key = 'vehicle.comments' THEN
      matching_count := CASE WHEN nullif(btrim(coalesce(target.publication_description, target.custom_comments, target.comments)), '') IS NULL THEN 0 ELSE 1 END;
    ELSIF rule.rule_key = 'vehicle.specifications' THEN
      matching_count := CASE WHEN equipment_total > 0 THEN 1 ELSE 0 END;
    ELSIF rule.rule_key = 'media.minimum_photos' THEN
      minimum_required := greatest(0, least(200, coalesce((rule.config->>'minimum')::integer, 0)));
      matching_count := CASE WHEN photo_total >= minimum_required THEN 1 ELSE 0 END;
    ELSIF rule.rule_key = 'media.odometer' THEN
      SELECT count(*) INTO matching_count FROM public.photos
      WHERE vehicle_id = target.id AND media_kind = 'photo' AND media_category = 'odometer';
    ELSIF rule.rule_key = 'media.vin' THEN
      SELECT count(*) INTO matching_count FROM public.photos
      WHERE vehicle_id = target.id AND media_kind = 'photo' AND media_category = 'vin';
    ELSIF rule.rule_key = 'media.video' THEN
      matching_count := CASE WHEN video_total > 0 THEN 1 ELSE 0 END;
    ELSIF rule.rule_key = 'media.exterior_360' THEN
      SELECT count(*) INTO matching_count FROM public.photos
      WHERE vehicle_id = target.id AND media_kind = 'exterior_360';
    ELSIF rule.rule_key = 'media.interior_360' THEN
      SELECT count(*) INTO matching_count FROM public.photos
      WHERE vehicle_id = target.id AND media_kind = 'interior_360';
    ELSIF rule.rule_key = 'processing.no_failures' THEN
      failures_block := true;
      matching_count := CASE WHEN has_failed_processing THEN 0 ELSE 1 END;
    ELSIF rule.rule_key = 'processing.completed' THEN
      processing_required := true;
      SELECT count(*) INTO matching_count FROM public.photos
      WHERE vehicle_id = target.id AND processing_action <> 'keep_original'
        AND processing_status <> 'completed';
      matching_count := CASE WHEN matching_count = 0 THEN 1 ELSE 0 END;
    ELSIF rule.rule_key = 'processing.review_approved' THEN
      approval_required := true;
      SELECT count(*) INTO matching_count FROM public.photos
      WHERE vehicle_id = target.id AND processing_action <> 'keep_original'
        AND review_status <> 'approved';
      matching_count := CASE WHEN matching_count = 0 THEN 1 ELSE 0 END;
    END IF;

    IF matching_count = 0 THEN
      reason_list := reason_list || jsonb_build_array(jsonb_build_object(
        'key', rule.rule_key, 'label', rule.label, 'severity', rule.severity,
        'details', rule.config
      ));
    END IF;
  END LOOP;

  FOR shot_requirement IN
    SELECT * FROM public.photo_shot_requirements
    WHERE dealership_id = target.dealership_id AND enabled AND required
      AND coalesce(target.inventory_type, 'used') = ANY (applies_to)
    ORDER BY sort_order, label
  LOOP
    SELECT count(*) INTO matching_count FROM public.photos
    WHERE vehicle_id = target.id AND media_kind = 'photo'
      AND lower(btrim(coalesce(shot_type, ''))) = lower(btrim(shot_requirement.label));
    IF matching_count < shot_requirement.minimum_count THEN
      reason_list := reason_list || jsonb_build_array(jsonb_build_object(
        'key', 'shot.' || shot_requirement.shot_key,
        'label', shot_requirement.label || ' missing',
        'severity', 'attention',
        'details', jsonb_build_object('category', shot_requirement.category,
          'minimum_count', shot_requirement.minimum_count, 'captured_count', matching_count)
      ));
    END IF;
  END LOOP;

  FOR requirement IN
    SELECT * FROM public.document_requirements
    WHERE dealership_id = target.dealership_id AND enabled AND required
      AND coalesce(target.inventory_type, 'used') = ANY (applies_to)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.generated_documents AS generated
      WHERE generated.vehicle_id = target.id
        AND generated.document_type = requirement.document_type
        AND generated.status = 'generated' AND generated.stale_at IS NULL
    ) THEN
      reason_list := reason_list || jsonb_build_array(jsonb_build_object(
        'key', 'document.' || requirement.document_type,
        'label', initcap(replace(requirement.document_type, '_', ' ')) || ' required',
        'severity', 'attention', 'details', '{}'::jsonb
      ));
    END IF;
  END LOOP;

  IF (failures_block AND has_failed_processing) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(reason_list) AS item
    WHERE item->>'severity' = 'blocked'
  ) THEN
    next_status := 'blocked';
  ELSIF processing_required AND has_active_processing THEN
    next_status := 'processing';
  ELSIF approval_required AND has_pending_review THEN
    next_status := 'awaiting_review';
  ELSIF jsonb_array_length(reason_list) > 0 THEN
    next_status := 'needs_attention';
  END IF;

  INSERT INTO public.vehicle_readiness
    (vehicle_id, dealership_id, status, reasons, photo_count, video_count,
     completed_document_count, evaluated_at, evaluator_version)
  VALUES
    (target.id, target.dealership_id, next_status, reason_list, photo_total, video_total,
     document_total, now(), 2)
  ON CONFLICT (vehicle_id) DO UPDATE
  SET dealership_id = EXCLUDED.dealership_id, status = EXCLUDED.status,
      reasons = EXCLUDED.reasons, photo_count = EXCLUDED.photo_count,
      video_count = EXCLUDED.video_count,
      completed_document_count = EXCLUDED.completed_document_count,
      evaluated_at = EXCLUDED.evaluated_at,
      evaluator_version = EXCLUDED.evaluator_version
  RETURNING * INTO result;

  UPDATE public.vehicles
  SET retail_readiness_status = next_status, updated_at = now()
  WHERE id = target.id AND retail_readiness_status IS DISTINCT FROM next_status;
  RETURN result;
END;
$$;

DROP TRIGGER generated_documents_refresh_vehicle_readiness ON public.generated_documents;
CREATE TRIGGER generated_documents_refresh_vehicle_readiness
AFTER INSERT OR UPDATE OF status, stale_at OR DELETE
ON public.generated_documents FOR EACH ROW EXECUTE FUNCTION private.refresh_vehicle_readiness_trigger();

CREATE OR REPLACE FUNCTION private.enforce_capture_completion_requirements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  missing jsonb;
BEGIN
  IF NEW.status IN ('completed','prepared') AND OLD.status = 'in_progress' THEN
    missing := private.capture_session_missing_requirements(NEW.id);
    NEW.missing_requirements := missing;
    IF NEW.completion_policy = 'block' AND jsonb_array_length(missing) > 0 THEN
      RAISE EXCEPTION 'Required photos are missing: %', (
        SELECT string_agg(item->>'label', ', ')
        FROM jsonb_array_elements(missing) AS item
      ) USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER photo_capture_sessions_enforce_completion
BEFORE UPDATE OF status ON public.photo_capture_sessions
FOR EACH ROW EXECUTE FUNCTION private.enforce_capture_completion_requirements();

CREATE OR REPLACE FUNCTION public.get_capture_session_completeness(_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.photo_capture_sessions;
  missing jsonb;
  captured_count integer;
BEGIN
  SELECT * INTO target FROM public.photo_capture_sessions WHERE id = _session_id;
  IF target.id IS NULL OR NOT private.current_user_can_mutate_capture_session(target.id) THEN
    RAISE EXCEPTION 'Capture session is unavailable.' USING ERRCODE = '42501';
  END IF;
  missing := private.capture_session_missing_requirements(target.id);
  IF target.mode = 'bulk' THEN
    SELECT count(*) INTO captured_count FROM public.bulk_photo_items WHERE session_id = target.id;
  ELSE
    SELECT count(*) INTO captured_count FROM public.photos WHERE capture_session_id = target.id;
  END IF;
  RETURN jsonb_build_object(
    'session_id', target.id,
    'captured_count', captured_count,
    'required_count', (
      SELECT count(*) FROM jsonb_array_elements(target.requirements_snapshot) AS item
      WHERE coalesce((item->>'required')::boolean, false)
    ),
    'completed_required_count', greatest(0, (
      SELECT count(*) FROM jsonb_array_elements(target.requirements_snapshot) AS item
      WHERE coalesce((item->>'required')::boolean, false)
    ) - jsonb_array_length(missing)),
    'missing', missing,
    'completion_policy', target.completion_policy
  );
END;
$$;

REVOKE ALL ON FUNCTION private.enforce_capture_completion_requirements()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_capture_session_completeness(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_capture_session_completeness(uuid)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_vehicle_primary_asset(
  _vehicle_id uuid,
  _asset_type text,
  _asset_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  store_id uuid;
BEGIN
  SELECT dealership_id INTO store_id FROM public.vehicles
  WHERE id = _vehicle_id FOR UPDATE;
  IF store_id IS NULL OR NOT private.current_user_has_store_capability(store_id, 'media') THEN
    RAISE EXCEPTION 'Vehicle media is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF _asset_type = 'photo' THEN
    IF NOT EXISTS (SELECT 1 FROM public.photos WHERE id = _asset_id AND vehicle_id = _vehicle_id) THEN
      RAISE EXCEPTION 'Photo is unavailable.' USING ERRCODE = 'P0002';
    END IF;
  ELSIF _asset_type = 'document' THEN
    IF NOT EXISTS (SELECT 1 FROM public.vehicle_documents WHERE id = _asset_id AND vehicle_id = _vehicle_id) THEN
      RAISE EXCEPTION 'Document is unavailable.' USING ERRCODE = 'P0002';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported primary asset type.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.photos SET is_main = false WHERE vehicle_id = _vehicle_id AND is_main;
  UPDATE public.vehicle_documents SET is_main = false
  WHERE vehicle_id = _vehicle_id AND is_main;
  IF _asset_type = 'photo' THEN
    UPDATE public.photos SET is_main = true WHERE id = _asset_id AND vehicle_id = _vehicle_id;
  ELSE
    UPDATE public.vehicle_documents SET is_main = true
    WHERE id = _asset_id AND vehicle_id = _vehicle_id;
  END IF;
  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('vehicle_media.primary_changed', actor_id, store_id,
          jsonb_build_object('vehicle_id', _vehicle_id, 'asset_type', _asset_type,
                             'asset_id', _asset_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.reorder_vehicle_gallery(
  _vehicle_id uuid,
  _items jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  store_id uuid;
  expected_count integer;
  supplied_count integer;
  item jsonb;
  item_id uuid;
  item_type text;
  position integer := 0;
BEGIN
  SELECT dealership_id INTO store_id FROM public.vehicles
  WHERE id = _vehicle_id FOR UPDATE;
  IF store_id IS NULL OR NOT private.current_user_has_store_capability(store_id, 'media') THEN
    RAISE EXCEPTION 'Vehicle media is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) > 500 THEN
    RAISE EXCEPTION 'Gallery order must be a bounded array.' USING ERRCODE = '22023';
  END IF;
  SELECT (SELECT count(*) FROM public.photos WHERE vehicle_id = _vehicle_id)
       + (SELECT count(*) FROM public.vehicle_documents WHERE vehicle_id = _vehicle_id)
  INTO expected_count;
  supplied_count := jsonb_array_length(_items);
  IF supplied_count <> expected_count THEN
    RAISE EXCEPTION 'Gallery changed while it was being reordered. Reload and try again.'
      USING ERRCODE = '40001';
  END IF;
  IF (
    SELECT count(DISTINCT (entry->>'type') || ':' || (entry->>'id'))
    FROM jsonb_array_elements(_items) AS entry
  ) <> supplied_count THEN
    RAISE EXCEPTION 'Gallery order contains duplicate assets.' USING ERRCODE = '22023';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(_items)
  LOOP
    item_type := item->>'type';
    BEGIN item_id := (item->>'id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Gallery asset identifier is invalid.' USING ERRCODE = '22023';
    END;
    IF item_type = 'photo' THEN
      IF NOT EXISTS (SELECT 1 FROM public.photos WHERE id = item_id AND vehicle_id = _vehicle_id) THEN
        RAISE EXCEPTION 'Gallery changed while it was being reordered. Reload and try again.'
          USING ERRCODE = '40001';
      END IF;
    ELSIF item_type = 'document' THEN
      IF NOT EXISTS (SELECT 1 FROM public.vehicle_documents WHERE id = item_id AND vehicle_id = _vehicle_id) THEN
        RAISE EXCEPTION 'Gallery changed while it was being reordered. Reload and try again.'
          USING ERRCODE = '40001';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported gallery asset type.' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- Move both tables out of the final range before assigning the requested
  -- sequence. The locked vehicle row serializes all gallery mutations.
  UPDATE public.photos SET sort_order = sort_order + 1000000 WHERE vehicle_id = _vehicle_id;
  UPDATE public.vehicle_documents SET sort_order = sort_order + 1000000
  WHERE vehicle_id = _vehicle_id;
  FOR item IN SELECT value FROM jsonb_array_elements(_items)
  LOOP
    item_id := (item->>'id')::uuid;
    IF item->>'type' = 'photo' THEN
      UPDATE public.photos SET sort_order = position WHERE id = item_id;
    ELSE
      UPDATE public.vehicle_documents SET sort_order = position WHERE id = item_id;
    END IF;
    position := position + 1;
  END LOOP;
  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('vehicle_media.order_changed', actor_id, store_id,
          jsonb_build_object('vehicle_id', _vehicle_id, 'asset_count', supplied_count));
END;
$$;

REVOKE ALL ON FUNCTION public.set_vehicle_primary_asset(uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reorder_vehicle_gallery(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_vehicle_primary_asset(uuid, text, uuid)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reorder_vehicle_gallery(uuid, jsonb)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_bulk_primary_item(
  _session_id uuid,
  _item_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  store_id uuid;
BEGIN
  SELECT dealership_id INTO store_id FROM public.photo_capture_sessions
  WHERE id = _session_id FOR UPDATE;
  IF store_id IS NULL OR NOT private.current_user_has_store_capability(store_id, 'media') THEN
    RAISE EXCEPTION 'Bulk photo package is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.bulk_photo_items
    WHERE id = _item_id AND session_id = _session_id
  ) THEN
    RAISE EXCEPTION 'Bulk photo is unavailable.' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.bulk_photo_items SET is_main = (id = _item_id)
  WHERE session_id = _session_id;
  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('bulk_photo.primary_changed', actor_id, store_id,
          jsonb_build_object('session_id', _session_id, 'item_id', _item_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.reorder_bulk_photo_items(
  _session_id uuid,
  _item_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  store_id uuid;
  expected_count integer;
  item_id uuid;
  position integer := 0;
BEGIN
  SELECT dealership_id INTO store_id FROM public.photo_capture_sessions
  WHERE id = _session_id FOR UPDATE;
  IF store_id IS NULL OR NOT private.current_user_has_store_capability(store_id, 'media') THEN
    RAISE EXCEPTION 'Bulk photo package is unavailable.' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO expected_count FROM public.bulk_photo_items
  WHERE session_id = _session_id;
  IF coalesce(cardinality(_item_ids), 0) <> expected_count
     OR (SELECT count(DISTINCT supplied) FROM unnest(_item_ids) AS supplied) <> expected_count
     OR EXISTS (
       SELECT 1 FROM unnest(_item_ids) AS supplied
       WHERE NOT EXISTS (
         SELECT 1 FROM public.bulk_photo_items
         WHERE id = supplied AND session_id = _session_id
       )
     ) THEN
    RAISE EXCEPTION 'Bulk package changed while it was being reordered. Reload and try again.'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.bulk_photo_items SET sort_order = sort_order + 1000000
  WHERE session_id = _session_id;
  FOREACH item_id IN ARRAY _item_ids LOOP
    UPDATE public.bulk_photo_items SET sort_order = position WHERE id = item_id;
    position := position + 1;
  END LOOP;
  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('bulk_photo.order_changed', actor_id, store_id,
          jsonb_build_object('session_id', _session_id, 'item_count', expected_count));
END;
$$;

REVOKE ALL ON FUNCTION public.set_bulk_primary_item(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reorder_bulk_photo_items(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_bulk_primary_item(uuid, uuid)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reorder_bulk_photo_items(uuid, uuid[])
TO authenticated, service_role;

-- Processed variants and approval state are office/media actions. Capture users
-- retain raw insertion and classification without a browser path to forge a
-- processed or approved result.
REVOKE INSERT ON public.media_variants FROM authenticated;
REVOKE UPDATE ON public.photos FROM authenticated;
GRANT UPDATE (shot_type, media_category) ON public.photos TO authenticated;
REVOKE UPDATE ON public.vehicle_documents FROM authenticated;
REVOKE UPDATE ON public.bulk_photo_items FROM authenticated;
GRANT UPDATE (shot_type) ON public.bulk_photo_items TO authenticated;

-- INSERT privileges are needed for raw capture and document attachment, but
-- callers must not be able to smuggle processed state or a second primary
-- asset through those INSERT paths.
CREATE OR REPLACE FUNCTION private.enforce_raw_photo_insert_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.original_image_url := NEW.image_url;
  NEW.is_main := false;
  NEW.is_cutout := false;
  NEW.cutout_status := 'none';
  NEW.cutout_image_url := NULL;
  NEW.corrected_cutout_url := NULL;
  NEW.overlay_id := NULL;
  NEW.photo_state := 'raw';
  NEW.approved_variant_id := NULL;
  NEW.processing_action := 'keep_original';
  NEW.processing_status := 'not_required';
  NEW.processing_provider := NULL;
  NEW.processing_error := NULL;
  NEW.review_status := 'unreviewed';
  NEW.publication_status := 'unpublished';
  RETURN NEW;
END;
$$;

CREATE TRIGGER photos_enforce_raw_insert_defaults
BEFORE INSERT ON public.photos
FOR EACH ROW EXECUTE FUNCTION private.enforce_raw_photo_insert_defaults();

CREATE OR REPLACE FUNCTION private.prevent_inserted_primary_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.is_main := false;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vehicle_documents_prevent_inserted_primary
BEFORE INSERT ON public.vehicle_documents
FOR EACH ROW EXECUTE FUNCTION private.prevent_inserted_primary_document();

CREATE TRIGGER bulk_photo_items_prevent_inserted_primary
BEFORE INSERT ON public.bulk_photo_items
FOR EACH ROW EXECUTE FUNCTION private.prevent_inserted_primary_document();

REVOKE ALL ON FUNCTION private.enforce_raw_photo_insert_defaults()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.prevent_inserted_primary_document()
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.current_user_has_store_capability(
  _dealership_id uuid,
  _capability text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE private.current_user_store_role(_dealership_id)
    WHEN 'platform_admin' THEN true
    WHEN 'group_admin' THEN true
    WHEN 'dealer_admin' THEN true
    WHEN 'store_manager' THEN _capability = ANY (ARRAY[
      'inventory','media','documents','reports','settings','payout_status','payout_adjustment'
    ])
    WHEN 'inventory_media' THEN _capability = ANY (ARRAY['inventory','media','documents'])
    WHEN 'photographer' THEN _capability = ANY (ARRAY['inventory_read','capture','self_reports'])
    WHEN 'accounting' THEN _capability = ANY (ARRAY[
      'reports','payout_status','payout_adjustment'
    ])
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION private.current_user_has_store_capability(uuid, text)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.current_user_has_store_capability(uuid, text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.create_payout_rule(
  _dealership_id uuid,
  _name text,
  _task_type text,
  _amount numeric,
  _effective_from date DEFAULT CURRENT_DATE,
  _config jsonb DEFAULT '{}'::jsonb
)
RETURNS public.payout_rules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  next_version integer;
  result public.payout_rules;
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'settings') THEN
    RAISE EXCEPTION 'Payout settings are unavailable.' USING ERRCODE = '42501';
  END IF;
  IF _task_type NOT IN ('photo_shoot','video','exterior_360','interior_360','reshoot','audit','manual')
     OR _amount < 0 OR _amount > 100000 OR nullif(btrim(_name), '') IS NULL
     OR jsonb_typeof(coalesce(_config, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Invalid payout rule.' USING ERRCODE = '22023';
  END IF;

  -- The store row is the version-allocation lock. Concurrent edits cannot
  -- receive the same version or leave multiple active rules for one task.
  PERFORM 1 FROM public.dealerships WHERE id = _dealership_id FOR UPDATE;
  SELECT coalesce(max(version), 0) + 1 INTO next_version
  FROM public.payout_rules
  WHERE dealership_id = _dealership_id AND task_type = _task_type;
  UPDATE public.payout_rules SET active = false, effective_to = CASE
    WHEN effective_from < _effective_from THEN _effective_from - 1 ELSE effective_to END
  WHERE dealership_id = _dealership_id AND task_type = _task_type AND active;

  INSERT INTO public.payout_rules
    (dealership_id, name, task_type, amount, version, effective_from,
     config, created_by)
  VALUES
    (_dealership_id, left(btrim(_name), 160), _task_type, _amount,
     next_version, _effective_from, coalesce(_config, '{}'::jsonb), actor_id)
  RETURNING * INTO result;
  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('payout.rule_created', actor_id, _dealership_id,
          jsonb_build_object('rule_id', result.id, 'task_type', result.task_type,
                             'version', result.version, 'amount', result.amount));
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.disable_payout_rule(_rule_id uuid)
RETURNS public.payout_rules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.payout_rules;
BEGIN
  SELECT * INTO target FROM public.payout_rules WHERE id = _rule_id FOR UPDATE;
  IF target.id IS NULL
     OR NOT private.current_user_has_store_capability(target.dealership_id, 'settings') THEN
    RAISE EXCEPTION 'Payout rule is unavailable.' USING ERRCODE = '42501';
  END IF;
  IF target.active THEN
    UPDATE public.payout_rules
    SET active = false, effective_to = coalesce(effective_to, CURRENT_DATE)
    WHERE id = target.id RETURNING * INTO target;
    INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
    VALUES ('payout.rule_disabled', actor_id, target.dealership_id,
            jsonb_build_object('rule_id', target.id, 'task_type', target.task_type,
                               'version', target.version));
  END IF;
  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_manual_payout_adjustment(
  _dealership_id uuid,
  _employee_id uuid,
  _amount numeric,
  _reason text,
  _work_date date DEFAULT CURRENT_DATE
)
RETURNS public.payout_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  store public.dealerships;
  result public.payout_entries;
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id, 'payout_adjustment') THEN
    RAISE EXCEPTION 'Payout adjustments are unavailable.' USING ERRCODE = '42501';
  END IF;
  IF _amount = 0 OR abs(_amount) > 100000
     OR length(btrim(coalesce(_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Adjustment amount and reason are required.' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles AS profile
    JOIN public.user_onboarding AS onboarding ON onboarding.profile_id = profile.id
    JOIN public.profile_dealerships AS membership ON membership.profile_id = profile.id
    WHERE profile.id = _employee_id AND profile.status = 'active'
      AND onboarding.onboarding_state = 'complete'
      AND onboarding.password_change_required = false
      AND membership.dealership_id = _dealership_id
      AND membership.payout_eligible = true
  ) THEN
    RAISE EXCEPTION 'Employee is unavailable for this store.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO store FROM public.dealerships WHERE id = _dealership_id FOR SHARE;
  INSERT INTO public.payout_entries
    (dealership_id, organization_id, employee_id, task_type, work_date,
     amount, rule_snapshot, notes)
  VALUES
    (_dealership_id, store.organization_id, _employee_id, 'manual', _work_date,
     _amount, jsonb_build_object('type', 'manual_adjustment', 'reason', btrim(_reason),
                                 'authorized_by', actor_id), btrim(_reason))
  RETURNING * INTO result;
  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('payout.manual_adjustment_created', actor_id, _dealership_id,
          jsonb_build_object('payout_id', result.id, 'employee_id', _employee_id,
                             'amount', _amount, 'work_date', _work_date));
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_payout_status(
  _payout_id uuid,
  _status text
)
RETURNS public.payout_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.payout_entries;
  prior_status text;
BEGIN
  SELECT * INTO target FROM public.payout_entries WHERE id = _payout_id FOR UPDATE;
  IF target.id IS NULL
     OR NOT private.current_user_has_store_capability(target.dealership_id, 'payout_status') THEN
    RAISE EXCEPTION 'Payout is unavailable.' USING ERRCODE = '42501';
  END IF;
  prior_status := target.status;
  IF prior_status = 'pending' AND _status NOT IN ('approved','void') THEN
    RAISE EXCEPTION 'Pending payouts must be approved before payment.' USING ERRCODE = '55000';
  ELSIF prior_status = 'approved' AND _status NOT IN ('paid','void') THEN
    RAISE EXCEPTION 'Approved payouts may only be paid or voided.' USING ERRCODE = '55000';
  ELSIF prior_status IN ('paid','void') THEN
    RAISE EXCEPTION 'Paid and void payouts are immutable.' USING ERRCODE = '55000';
  END IF;

  UPDATE public.payout_entries
  SET status = _status,
      approved_by = CASE WHEN _status IN ('approved','paid') THEN coalesce(approved_by, actor_id) ELSE approved_by END,
      approved_at = CASE WHEN _status IN ('approved','paid') THEN coalesce(approved_at, now()) ELSE approved_at END,
      paid_by = CASE WHEN _status = 'paid' THEN actor_id ELSE NULL END,
      paid_at = CASE WHEN _status = 'paid' THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = target.id RETURNING * INTO target;
  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('payout.status_changed', actor_id, target.dealership_id,
          jsonb_build_object('payout_id', target.id, 'from_status', prior_status,
                             'to_status', target.status, 'employee_id', target.employee_id,
                             'amount', target.amount));
  RETURN target;
END;
$$;

REVOKE ALL ON FUNCTION public.disable_payout_rule(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_manual_payout_adjustment(uuid, uuid, numeric, text, date)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.disable_payout_rule(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_manual_payout_adjustment(uuid, uuid, numeric, text, date)
TO authenticated, service_role;

INSERT INTO public.readiness_rules
  (dealership_id, rule_key, label, severity, applies_to, config, enabled, sort_order)
SELECT store.id, seed.rule_key, seed.label, seed.severity, seed.applies_to,
       seed.config, seed.enabled, seed.sort_order
FROM public.dealerships AS store
CROSS JOIN (VALUES
  ('vehicle.comments', 'Merchandising comments added', 'attention', ARRAY['used','certified']::text[], '{}'::jsonb, false, 35),
  ('vehicle.specifications', 'Vehicle specifications added', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 37),
  ('media.odometer', 'Odometer photo captured', 'attention', ARRAY['used','certified']::text[], '{}'::jsonb, false, 42),
  ('media.vin', 'VIN photo captured', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 44),
  ('media.video', 'Vehicle video captured', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 46),
  ('media.exterior_360', 'Exterior 360 captured', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 47),
  ('media.interior_360', 'Interior 360 captured', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 48),
  ('processing.completed', 'Required media processing completed', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 52),
  ('processing.review_approved', 'Processed media approved', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 54)
) AS seed(rule_key, label, severity, applies_to, config, enabled, sort_order)
ON CONFLICT (dealership_id, rule_key) DO NOTHING;

CREATE OR REPLACE FUNCTION private.seed_dealership_acceptance_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.readiness_rules
    (dealership_id, rule_key, label, severity, applies_to, config, enabled, sort_order)
  SELECT NEW.id, seed.rule_key, seed.label, seed.severity, seed.applies_to,
         seed.config, seed.enabled, seed.sort_order
  FROM (VALUES
    ('vehicle.comments', 'Merchandising comments added', 'attention', ARRAY['used','certified']::text[], '{}'::jsonb, false, 35),
    ('vehicle.specifications', 'Vehicle specifications added', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 37),
    ('media.odometer', 'Odometer photo captured', 'attention', ARRAY['used','certified']::text[], '{}'::jsonb, false, 42),
    ('media.vin', 'VIN photo captured', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 44),
    ('media.video', 'Vehicle video captured', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 46),
    ('media.exterior_360', 'Exterior 360 captured', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 47),
    ('media.interior_360', 'Interior 360 captured', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 48),
    ('processing.completed', 'Required media processing completed', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 52),
    ('processing.review_approved', 'Processed media approved', 'attention', ARRAY['new','used','certified']::text[], '{}'::jsonb, false, 54)
  ) AS seed(rule_key, label, severity, applies_to, config, enabled, sort_order)
  ON CONFLICT (dealership_id, rule_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dealerships_seed_acceptance_defaults
AFTER INSERT ON public.dealerships
FOR EACH ROW EXECUTE FUNCTION private.seed_dealership_acceptance_defaults();

REVOKE ALL ON FUNCTION private.seed_dealership_acceptance_defaults()
FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.photography_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_shot_requirements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.photography_settings, public.photo_shot_requirements
FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.photography_settings, public.photo_shot_requirements TO authenticated;
GRANT ALL ON public.photography_settings, public.photo_shot_requirements TO service_role;

CREATE POLICY "Active members view photography settings"
ON public.photography_settings FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members view photo shot requirements"
ON public.photo_shot_requirements FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

REVOKE ALL ON FUNCTION public.save_readiness_configuration(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_photography_configuration(uuid, text, jsonb)
FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_media_processing_configuration(uuid, jsonb)
FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_document_requirements(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_readiness_configuration(uuid, jsonb)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_photography_configuration(uuid, text, jsonb)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_media_processing_configuration(uuid, jsonb)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_document_requirements(uuid, jsonb)
TO authenticated, service_role;

-- Recompute cached statuses with evaluator v2 after all new defaults exist.
SELECT private.evaluate_vehicle_readiness(vehicle.id)
FROM public.vehicles AS vehicle;
