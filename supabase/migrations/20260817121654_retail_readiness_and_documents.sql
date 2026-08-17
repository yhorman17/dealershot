-- Configurable Retail Ready evaluation and reusable generated-document records.

CREATE TABLE public.readiness_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  rule_key text NOT NULL CHECK (rule_key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 160),
  severity text NOT NULL DEFAULT 'attention' CHECK (severity IN ('attention', 'blocked')),
  applies_to text[] NOT NULL DEFAULT ARRAY['new','used','certified']::text[],
  config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 65536),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dealership_id, rule_key),
  CHECK (applies_to <@ ARRAY['new','used','certified']::text[])
);

CREATE INDEX readiness_rules_dealership_enabled_idx
  ON public.readiness_rules (dealership_id, enabled, sort_order);

INSERT INTO public.readiness_rules
  (dealership_id, rule_key, label, severity, config, sort_order)
SELECT d.id, seed.rule_key, seed.label, seed.severity, seed.config, seed.sort_order
FROM public.dealerships AS d
CROSS JOIN (VALUES
  ('vehicle.vin', 'VIN available', 'blocked', '{}'::jsonb, 10),
  ('vehicle.stock_number', 'Stock number available', 'attention', '{}'::jsonb, 20),
  ('vehicle.price', 'Retail price available', 'attention', '{}'::jsonb, 30),
  ('media.minimum_photos', 'Minimum photo count', 'attention', '{"minimum":1}'::jsonb, 40),
  ('processing.no_failures', 'No failed media processing', 'blocked', '{}'::jsonb, 50)
) AS seed(rule_key, label, severity, config, sort_order)
ON CONFLICT (dealership_id, rule_key) DO NOTHING;

CREATE TABLE public.document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  dealership_id uuid REFERENCES public.dealerships(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('window_sticker', 'buyers_guide', 'addendum', 'cpo_sheet', 'placard')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'retired')),
  template_config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(template_config) = 'object' AND octet_length(template_config::text) <= 131072),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (dealership_id IS NOT NULL OR organization_id IS NOT NULL)
);

CREATE UNIQUE INDEX document_templates_active_store_type_idx
  ON public.document_templates (dealership_id, document_type)
  WHERE status = 'active' AND dealership_id IS NOT NULL;
CREATE INDEX document_templates_organization_idx
  ON public.document_templates (organization_id, document_type, version DESC)
  WHERE organization_id IS NOT NULL;
CREATE INDEX document_templates_created_by_idx
  ON public.document_templates (created_by, created_at DESC) WHERE created_by IS NOT NULL;

INSERT INTO public.document_templates
  (dealership_id, organization_id, document_type, name, version, status, template_config)
SELECT d.id, d.organization_id, seed.document_type, seed.name, 1, 'active', seed.config
FROM public.dealerships AS d
CROSS JOIN (VALUES
  ('window_sticker', 'DealerShot Window Sticker', '{"paper":"letter","orientation":"portrait"}'::jsonb),
  ('buyers_guide', 'DealerShot Buyer''s Guide', '{"paper":"letter","orientation":"portrait","compliance_status":"requires_validation"}'::jsonb),
  ('addendum', 'DealerShot Addendum', '{"paper":"letter","orientation":"portrait"}'::jsonb),
  ('cpo_sheet', 'DealerShot CPO Sheet', '{"paper":"letter","orientation":"portrait"}'::jsonb),
  ('placard', 'DealerShot Vehicle Placard', '{"paper":"letter","orientation":"landscape"}'::jsonb)
) AS seed(document_type, name, config)
ON CONFLICT (dealership_id, document_type) WHERE status = 'active' AND dealership_id IS NOT NULL
DO NOTHING;

CREATE TABLE public.document_requirements (
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('window_sticker', 'buyers_guide', 'addendum', 'cpo_sheet', 'placard')),
  applies_to text[] NOT NULL DEFAULT ARRAY['used']::text[],
  required boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dealership_id, document_type),
  CHECK (applies_to <@ ARRAY['new','used','certified']::text[])
);

INSERT INTO public.document_requirements
  (dealership_id, document_type, applies_to, required, enabled)
SELECT d.id, seed.document_type, seed.applies_to, seed.required, true
FROM public.dealerships AS d
CROSS JOIN (VALUES
  ('window_sticker', ARRAY['used','certified']::text[], true),
  ('buyers_guide', ARRAY['used','certified']::text[], true),
  ('addendum', ARRAY['new','used','certified']::text[], false),
  ('cpo_sheet', ARRAY['certified']::text[], false),
  ('placard', ARRAY['new','used','certified']::text[], false)
) AS seed(document_type, applies_to, required)
ON CONFLICT (dealership_id, document_type) DO NOTHING;

CREATE TABLE public.generated_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('window_sticker', 'buyers_guide', 'addendum', 'cpo_sheet', 'placard')),
  template_id uuid REFERENCES public.document_templates(id) ON DELETE RESTRICT,
  template_version integer NOT NULL CHECK (template_version > 0),
  vehicle_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(vehicle_snapshot) = 'object' AND octet_length(vehicle_snapshot::text) <= 262144),
  file_url text,
  storage_path text,
  status text NOT NULL DEFAULT 'generated' CHECK (status IN ('generating', 'generated', 'failed', 'superseded')),
  safe_error_code text,
  generated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX generated_documents_vehicle_type_idx
  ON public.generated_documents (vehicle_id, document_type, generated_at DESC);
CREATE INDEX generated_documents_dealership_date_idx
  ON public.generated_documents (dealership_id, generated_at DESC);
CREATE INDEX generated_documents_generated_by_idx
  ON public.generated_documents (generated_by, generated_at DESC) WHERE generated_by IS NOT NULL;

CREATE TABLE public.vehicle_readiness (
  vehicle_id uuid PRIMARY KEY REFERENCES public.vehicles(id) ON DELETE CASCADE,
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('retail_ready', 'needs_attention', 'blocked', 'processing', 'awaiting_review')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(reasons) = 'array' AND octet_length(reasons::text) <= 131072),
  photo_count integer NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
  video_count integer NOT NULL DEFAULT 0 CHECK (video_count >= 0),
  completed_document_count integer NOT NULL DEFAULT 0 CHECK (completed_document_count >= 0),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  evaluator_version integer NOT NULL DEFAULT 1 CHECK (evaluator_version > 0)
);

CREATE INDEX vehicle_readiness_dealership_status_idx
  ON public.vehicle_readiness (dealership_id, status, evaluated_at DESC);

CREATE OR REPLACE FUNCTION private.seed_dealership_operational_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.media_processing_rules (dealership_id, media_category, action, priority)
  SELECT NEW.id, category,
         CASE WHEN category = 'exterior' THEN 'manual_review' ELSE 'keep_original' END, 0
  FROM unnest(ARRAY['exterior','interior','detail','odometer','vin','document','misc']) AS category
  ON CONFLICT (dealership_id, media_category) DO NOTHING;

  INSERT INTO public.readiness_rules
    (dealership_id, rule_key, label, severity, config, sort_order)
  VALUES
    (NEW.id, 'vehicle.vin', 'VIN available', 'blocked', '{}'::jsonb, 10),
    (NEW.id, 'vehicle.stock_number', 'Stock number available', 'attention', '{}'::jsonb, 20),
    (NEW.id, 'vehicle.price', 'Retail price available', 'attention', '{}'::jsonb, 30),
    (NEW.id, 'media.minimum_photos', 'Minimum photo count', 'attention', '{"minimum":1}'::jsonb, 40),
    (NEW.id, 'processing.no_failures', 'No failed media processing', 'blocked', '{}'::jsonb, 50)
  ON CONFLICT (dealership_id, rule_key) DO NOTHING;

  INSERT INTO public.document_templates
    (dealership_id, organization_id, document_type, name, version, status, template_config)
  VALUES
    (NEW.id, NEW.organization_id, 'window_sticker', 'DealerShot Window Sticker', 1, 'active', '{"paper":"letter","orientation":"portrait"}'::jsonb),
    (NEW.id, NEW.organization_id, 'buyers_guide', 'DealerShot Buyer''s Guide', 1, 'active', '{"paper":"letter","orientation":"portrait","compliance_status":"requires_validation"}'::jsonb),
    (NEW.id, NEW.organization_id, 'addendum', 'DealerShot Addendum', 1, 'active', '{"paper":"letter","orientation":"portrait"}'::jsonb),
    (NEW.id, NEW.organization_id, 'cpo_sheet', 'DealerShot CPO Sheet', 1, 'active', '{"paper":"letter","orientation":"portrait"}'::jsonb),
    (NEW.id, NEW.organization_id, 'placard', 'DealerShot Vehicle Placard', 1, 'active', '{"paper":"letter","orientation":"landscape"}'::jsonb)
  ON CONFLICT (dealership_id, document_type) WHERE status = 'active' AND dealership_id IS NOT NULL
  DO NOTHING;

  INSERT INTO public.document_requirements
    (dealership_id, document_type, applies_to, required, enabled)
  VALUES
    (NEW.id, 'window_sticker', ARRAY['used','certified']::text[], true, true),
    (NEW.id, 'buyers_guide', ARRAY['used','certified']::text[], true, true),
    (NEW.id, 'addendum', ARRAY['new','used','certified']::text[], false, true),
    (NEW.id, 'cpo_sheet', ARRAY['certified']::text[], false, true),
    (NEW.id, 'placard', ARRAY['new','used','certified']::text[], false, true)
  ON CONFLICT (dealership_id, document_type) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dealerships_seed_operational_defaults
AFTER INSERT ON public.dealerships
FOR EACH ROW EXECUTE FUNCTION private.seed_dealership_operational_defaults();

REVOKE ALL ON FUNCTION private.seed_dealership_operational_defaults()
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
  reason_list jsonb := '[]'::jsonb;
  photo_total integer := 0;
  video_total integer := 0;
  document_total integer := 0;
  minimum_required integer;
  matching_count integer;
  has_failed_processing boolean := false;
  has_active_processing boolean := false;
  has_pending_review boolean := false;
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

  SELECT count(*) INTO document_total
  FROM public.generated_documents
  WHERE vehicle_id = target.id AND status = 'generated';

  FOR rule IN
    SELECT * FROM public.readiness_rules
    WHERE dealership_id = target.dealership_id
      AND enabled
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
    ELSIF rule.rule_key = 'media.minimum_photos' THEN
      minimum_required := greatest(0, coalesce((rule.config->>'minimum')::integer, 0));
      matching_count := CASE WHEN photo_total >= minimum_required THEN 1 ELSE 0 END;
    ELSIF rule.rule_key = 'media.required_shot' THEN
      SELECT count(*) INTO matching_count FROM public.photos
      WHERE vehicle_id = target.id
        AND media_kind = 'photo'
        AND lower(coalesce(shot_type, '')) = lower(coalesce(rule.config->>'shot_type', ''));
    ELSIF rule.rule_key = 'media.video' THEN
      matching_count := CASE WHEN video_total > 0 THEN 1 ELSE 0 END;
    ELSIF rule.rule_key = 'media.exterior_360' THEN
      SELECT count(*) INTO matching_count FROM public.photos
      WHERE vehicle_id = target.id AND media_kind = 'exterior_360';
    ELSIF rule.rule_key = 'media.interior_360' THEN
      SELECT count(*) INTO matching_count FROM public.photos
      WHERE vehicle_id = target.id AND media_kind = 'interior_360';
    ELSIF rule.rule_key = 'processing.no_failures' THEN
      matching_count := CASE WHEN has_failed_processing THEN 0 ELSE 1 END;
    END IF;

    IF matching_count = 0 THEN
      reason_list := reason_list || jsonb_build_array(jsonb_build_object(
        'key', rule.rule_key, 'label', rule.label, 'severity', rule.severity,
        'details', rule.config
      ));
    END IF;
  END LOOP;

  FOR requirement IN
    SELECT * FROM public.document_requirements
    WHERE dealership_id = target.dealership_id
      AND enabled AND required
      AND coalesce(target.inventory_type, 'used') = ANY (applies_to)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.generated_documents AS gd
      WHERE gd.vehicle_id = target.id
        AND gd.document_type = requirement.document_type
        AND gd.status = 'generated'
    ) THEN
      reason_list := reason_list || jsonb_build_array(jsonb_build_object(
        'key', 'document.' || requirement.document_type,
        'label', initcap(replace(requirement.document_type, '_', ' ')) || ' required',
        'severity', 'attention', 'details', '{}'::jsonb
      ));
    END IF;
  END LOOP;

  IF has_failed_processing OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(reason_list) AS item
    WHERE item->>'severity' = 'blocked'
  ) THEN
    next_status := 'blocked';
  ELSIF has_active_processing THEN
    next_status := 'processing';
  ELSIF has_pending_review THEN
    next_status := 'awaiting_review';
  ELSIF jsonb_array_length(reason_list) > 0 THEN
    next_status := 'needs_attention';
  END IF;

  INSERT INTO public.vehicle_readiness
    (vehicle_id, dealership_id, status, reasons, photo_count, video_count,
     completed_document_count, evaluated_at, evaluator_version)
  VALUES
    (target.id, target.dealership_id, next_status, reason_list, photo_total, video_total,
     document_total, now(), 1)
  ON CONFLICT (vehicle_id) DO UPDATE
  SET dealership_id = EXCLUDED.dealership_id,
      status = EXCLUDED.status,
      reasons = EXCLUDED.reasons,
      photo_count = EXCLUDED.photo_count,
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

CREATE OR REPLACE FUNCTION public.refresh_vehicle_readiness(_vehicle_id uuid)
RETURNS public.vehicle_readiness
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.current_user_can_access_vehicle(_vehicle_id) THEN
    RAISE EXCEPTION 'Vehicle is unavailable.' USING ERRCODE = '42501';
  END IF;
  RETURN private.evaluate_vehicle_readiness(_vehicle_id);
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_vehicle_readiness_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_vehicle_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'vehicles' THEN
    target_vehicle_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    target_vehicle_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.vehicle_id ELSE NEW.vehicle_id END;
  END IF;
  PERFORM private.evaluate_vehicle_readiness(target_vehicle_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER vehicles_refresh_vehicle_readiness
AFTER INSERT OR UPDATE OF vin, stock_number, price, msrp, internet_price, sale_price,
  comments, custom_comments, publication_description, inventory_type
ON public.vehicles FOR EACH ROW EXECUTE FUNCTION private.refresh_vehicle_readiness_trigger();

CREATE TRIGGER photos_refresh_vehicle_readiness
AFTER INSERT OR UPDATE OF shot_type, media_kind, media_category, processing_status, review_status OR DELETE
ON public.photos FOR EACH ROW EXECUTE FUNCTION private.refresh_vehicle_readiness_trigger();

CREATE TRIGGER generated_documents_refresh_vehicle_readiness
AFTER INSERT OR UPDATE OF status OR DELETE
ON public.generated_documents FOR EACH ROW EXECUTE FUNCTION private.refresh_vehicle_readiness_trigger();

CREATE OR REPLACE FUNCTION public.generate_vehicle_document(
  _vehicle_id uuid,
  _document_type text
)
RETURNS public.generated_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.vehicles;
  store public.dealerships;
  template public.document_templates;
  result public.generated_documents;
  snapshot jsonb;
BEGIN
  IF _document_type NOT IN ('window_sticker','buyers_guide','addendum','cpo_sheet','placard') THEN
    RAISE EXCEPTION 'Unsupported document type.' USING ERRCODE = '22023';
  END IF;
  IF NOT private.current_user_can_access_vehicle(_vehicle_id) THEN
    RAISE EXCEPTION 'Vehicle is unavailable.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO target FROM public.vehicles WHERE id = _vehicle_id FOR SHARE;
  IF NOT private.current_user_has_store_capability(target.dealership_id, 'documents') THEN
    RAISE EXCEPTION 'Document generation is unavailable.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO store FROM public.dealerships WHERE id = target.dealership_id;
  SELECT * INTO template FROM public.document_templates
  WHERE dealership_id = target.dealership_id
    AND document_type = _document_type AND status = 'active'
  ORDER BY version DESC LIMIT 1;

  IF template.id IS NULL THEN
    RAISE EXCEPTION 'No active document template is configured.' USING ERRCODE = 'P0002';
  END IF;
  IF _document_type IN ('buyers_guide','window_sticker')
     AND coalesce(target.inventory_type, 'used') = 'new' THEN
    RAISE EXCEPTION 'This used-vehicle document does not apply to new inventory.' USING ERRCODE = '23514';
  END IF;

  snapshot := jsonb_build_object(
    'vehicle', to_jsonb(target) - 'source_metadata' - 'internal_notes',
    'dealership', jsonb_build_object(
      'id', store.id, 'name', store.name, 'address', store.address,
      'phone', store.phone, 'website', store.website, 'logo_url', store.logo_url
    ),
    'equipment', coalesce((
      SELECT jsonb_agg(jsonb_build_object('category', e.category, 'label', e.label, 'value', e.value)
                       ORDER BY e.category, e.sort_order, e.label)
      FROM public.vehicle_equipment AS e WHERE e.vehicle_id = target.id
    ), '[]'::jsonb),
    'warranty', coalesce((
      SELECT to_jsonb(w) - 'vehicle_id' FROM public.vehicle_warranties AS w
      WHERE w.vehicle_id = target.id
    ), '{}'::jsonb),
    'generated_at', now()
  );

  UPDATE public.generated_documents
  SET status = 'superseded', updated_at = now()
  WHERE vehicle_id = target.id AND document_type = _document_type AND status = 'generated';

  INSERT INTO public.generated_documents
    (vehicle_id, organization_id, dealership_id, document_type, template_id,
     template_version, vehicle_snapshot, status, generated_by)
  VALUES
    (target.id, store.organization_id, store.id, _document_type, template.id,
     template.version, snapshot, 'generated', actor_id)
  RETURNING * INTO result;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('vehicle_document.generated', actor_id, store.id,
          jsonb_build_object('vehicle_id', target.id, 'document_id', result.id,
                             'document_type', _document_type, 'template_version', template.version));

  PERFORM private.evaluate_vehicle_readiness(target.id);
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_photo_variant(
  _photo_id uuid,
  _variant_type text,
  _image_url text,
  _storage_path text DEFAULT NULL,
  _processing_provider text DEFAULT NULL
)
RETURNS public.media_variants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.photos%ROWTYPE;
  store_id uuid;
  source_id uuid;
  result public.media_variants%ROWTYPE;
BEGIN
  IF _variant_type NOT IN ('cutout','corrected_cutout','customized','enhanced','published') THEN
    RAISE EXCEPTION 'Unsupported media variant type.' USING ERRCODE = '22023';
  END IF;
  IF nullif(trim(_image_url), '') IS NULL THEN
    RAISE EXCEPTION 'A media URL is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO target FROM public.photos WHERE id = _photo_id FOR UPDATE;
  IF target.id IS NULL THEN
    RAISE EXCEPTION 'Photo not found.' USING ERRCODE = 'P0002';
  END IF;
  SELECT dealership_id INTO store_id FROM public.vehicles WHERE id = target.vehicle_id;
  IF NOT private.current_user_has_store_capability(store_id, 'media') THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO source_id
  FROM public.media_variants
  WHERE photo_id = target.id
  ORDER BY (variant_type = 'original') DESC, created_at DESC
  LIMIT 1;

  INSERT INTO public.media_variants
    (photo_id, variant_type, source_variant_id, image_url, storage_path,
     processing_provider, processing_status, created_by)
  VALUES
    (target.id, _variant_type, source_id, trim(_image_url), _storage_path,
     _processing_provider, 'completed', (SELECT auth.uid()))
  RETURNING * INTO result;

  UPDATE public.photos
  SET image_url = result.image_url,
      approved_variant_id = result.id,
      cutout_image_url = CASE
        WHEN _variant_type IN ('cutout','corrected_cutout') THEN result.image_url
        ELSE cutout_image_url END,
      corrected_cutout_url = CASE
        WHEN _variant_type = 'corrected_cutout' THEN result.image_url
        ELSE corrected_cutout_url END,
      is_cutout = CASE
        WHEN _variant_type IN ('cutout','corrected_cutout') THEN true
        ELSE is_cutout END,
      cutout_status = CASE
        WHEN _variant_type IN ('cutout','corrected_cutout') THEN 'done'
        ELSE cutout_status END,
      photo_state = CASE
        WHEN _variant_type IN ('cutout','corrected_cutout') THEN 'cutout'
        ELSE 'customized' END,
      processing_action = CASE
        WHEN _variant_type IN ('cutout','corrected_cutout') THEN 'manual_review'
        ELSE processing_action END,
      processing_provider = coalesce(_processing_provider, processing_provider),
      processing_status = 'completed',
      processing_error = NULL,
      review_status = 'awaiting_review',
      updated_at = now()
  WHERE id = target.id;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('vehicle_media.variant_created', (SELECT auth.uid()), store_id,
          jsonb_build_object('vehicle_id', target.vehicle_id, 'photo_id', target.id,
                             'variant_id', result.id, 'variant_type', _variant_type));
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_photo_variant(uuid, text, text, text, text)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.commit_photo_variant(uuid, text, text, text, text)
TO authenticated;

ALTER TABLE public.readiness_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_readiness ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.readiness_rules, public.document_templates,
  public.document_requirements, public.generated_documents, public.vehicle_readiness
FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.readiness_rules, public.document_templates,
  public.document_requirements, public.generated_documents, public.vehicle_readiness
TO authenticated;
GRANT ALL ON public.readiness_rules, public.document_templates,
  public.document_requirements, public.generated_documents, public.vehicle_readiness
TO service_role;

CREATE POLICY "Active members view readiness rules"
ON public.readiness_rules FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(dealership_id));
CREATE POLICY "Active members view document templates"
ON public.document_templates FOR SELECT TO authenticated
USING (
  (dealership_id IS NOT NULL AND private.current_user_has_active_membership(dealership_id))
  OR (organization_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.dealerships AS d
    WHERE d.organization_id = document_templates.organization_id
      AND private.current_user_has_active_membership(d.id)
  ))
);
CREATE POLICY "Active members view document requirements"
ON public.document_requirements FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(dealership_id));
CREATE POLICY "Active members view generated documents"
ON public.generated_documents FOR SELECT TO authenticated
USING (private.current_user_can_access_vehicle(vehicle_id));
CREATE POLICY "Active members view vehicle readiness"
ON public.vehicle_readiness FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

REVOKE ALL ON FUNCTION private.evaluate_vehicle_readiness(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_vehicle_readiness_trigger() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.refresh_vehicle_readiness(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.generate_vehicle_document(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_vehicle_readiness(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_vehicle_document(uuid, text) TO authenticated, service_role;

SELECT private.evaluate_vehicle_readiness(v.id)
FROM public.vehicles AS v;
