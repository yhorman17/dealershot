-- DealerShot NetLook-replacement domain foundation.
-- This migration is additive: existing dealership, vehicle, photo, and capture
-- records remain authoritative and receive compatibility backfills.

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.dealerships
  ADD COLUMN organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  ADD COLUMN website text,
  ADD COLUMN timezone text NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN branding jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(branding) = 'object' AND octet_length(branding::text) <= 65536),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Preserve every current store by placing it in its own organization. Stores
-- can be regrouped later without changing their stable dealership identifiers.
INSERT INTO public.organizations (id, name, status, created_at, updated_at)
SELECT d.id, d.name, CASE WHEN d.status = 'suspended' THEN 'suspended' ELSE 'active' END,
       d.created_at, now()
FROM public.dealerships AS d
ON CONFLICT (id) DO NOTHING;

UPDATE public.dealerships AS d
SET organization_id = d.id
WHERE organization_id IS NULL;

ALTER TABLE public.dealerships
  ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX dealerships_organization_idx
  ON public.dealerships (organization_id, status, name);

-- Preserve the existing owner-created dealership flow. When no organization
-- is supplied, a new store becomes the root store of a same-id organization.
CREATE OR REPLACE FUNCTION private.attach_dealership_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS NULL THEN NEW.id := gen_random_uuid(); END IF;
  IF NEW.organization_id IS NULL THEN
    INSERT INTO public.organizations (id, name, status)
    VALUES (NEW.id, NEW.name, CASE WHEN NEW.status = 'suspended' THEN 'suspended' ELSE 'active' END)
    ON CONFLICT (id) DO NOTHING;
    NEW.organization_id := NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dealerships_attach_organization
BEFORE INSERT ON public.dealerships
FOR EACH ROW EXECUTE FUNCTION private.attach_dealership_organization();

REVOKE ALL ON FUNCTION private.attach_dealership_organization()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.organization_memberships (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('group_admin', 'reporting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, profile_id)
);

CREATE INDEX organization_memberships_profile_idx
  ON public.organization_memberships (profile_id, organization_id);

ALTER TABLE public.profile_dealerships
  ADD COLUMN access_role text NOT NULL DEFAULT 'photographer'
    CHECK (access_role IN ('dealer_admin', 'store_manager', 'photographer', 'inventory_media', 'accounting')),
  ADD COLUMN payout_eligible boolean NOT NULL DEFAULT true;

UPDATE public.profile_dealerships AS pd
SET access_role = CASE p.role
  WHEN 'dealer_admin'::public.app_role THEN 'dealer_admin'
  ELSE 'photographer'
END
FROM public.profiles AS p
WHERE p.id = pd.profile_id;

ALTER TABLE public.vehicles
  ADD COLUMN source_provider text,
  ADD COLUMN source_external_id text,
  ADD COLUMN series text,
  ADD COLUMN inventory_type text CHECK (inventory_type IS NULL OR inventory_type IN ('new', 'used', 'certified')),
  ADD COLUMN certification_program text,
  ADD COLUMN inventory_arrival_date date,
  ADD COLUMN msrp numeric(12,2) CHECK (msrp IS NULL OR msrp >= 0),
  ADD COLUMN internet_price numeric(12,2) CHECK (internet_price IS NULL OR internet_price >= 0),
  ADD COLUMN sale_price numeric(12,2) CHECK (sale_price IS NULL OR sale_price >= 0),
  ADD COLUMN price_description text,
  ADD COLUMN category text,
  ADD COLUMN warranty_type text,
  ADD COLUMN comments text,
  ADD COLUMN custom_comments text,
  ADD COLUMN tagline text,
  ADD COLUMN internal_notes text,
  ADD COLUMN publication_description text,
  ADD COLUMN retail_readiness_status text NOT NULL DEFAULT 'needs_attention'
    CHECK (retail_readiness_status IN ('retail_ready', 'needs_attention', 'blocked', 'processing', 'awaiting_review')),
  ADD COLUMN publication_state text NOT NULL DEFAULT 'disabled'
    CHECK (publication_state IN ('disabled', 'pending', 'publishing', 'published', 'failed')),
  ADD COLUMN assigned_photographer_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_metadata) = 'object' AND octet_length(source_metadata::text) <= 131072),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.vehicles
SET inventory_type = CASE
  WHEN lower(coalesce(condition, '')) LIKE '%certif%' THEN 'certified'
  WHEN lower(coalesce(condition, '')) = 'new' THEN 'new'
  ELSE 'used'
END,
internet_price = price,
inventory_arrival_date = created_at::date
WHERE inventory_type IS NULL;

CREATE UNIQUE INDEX vehicles_source_external_idx
  ON public.vehicles (dealership_id, source_provider, source_external_id)
  WHERE source_provider IS NOT NULL AND source_external_id IS NOT NULL;
CREATE INDEX vehicles_inventory_search_idx
  ON public.vehicles (dealership_id, status, inventory_type, created_at DESC);
CREATE INDEX vehicles_readiness_idx
  ON public.vehicles (dealership_id, retail_readiness_status, created_at DESC);
CREATE INDEX vehicles_assigned_photographer_idx
  ON public.vehicles (dealership_id, assigned_photographer_id, created_at DESC)
  WHERE assigned_photographer_id IS NOT NULL;
CREATE INDEX vehicles_arrival_idx
  ON public.vehicles (dealership_id, inventory_arrival_date, id);

CREATE TABLE public.vehicle_equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('safety', 'interior', 'exterior', 'mechanical', 'entertainment', 'convenience')),
  feature_code text,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 160),
  value text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'provider', 'import')),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, category, label)
);

CREATE INDEX vehicle_equipment_vehicle_category_idx
  ON public.vehicle_equipment (vehicle_id, category, sort_order, label);

CREATE TABLE public.vehicle_warranties (
  vehicle_id uuid PRIMARY KEY REFERENCES public.vehicles(id) ON DELETE CASCADE,
  basic_years smallint CHECK (basic_years IS NULL OR basic_years >= 0),
  basic_miles integer CHECK (basic_miles IS NULL OR basic_miles >= 0),
  drivetrain_years smallint CHECK (drivetrain_years IS NULL OR drivetrain_years >= 0),
  drivetrain_miles integer CHECK (drivetrain_miles IS NULL OR drivetrain_miles >= 0),
  corrosion_years smallint CHECK (corrosion_years IS NULL OR corrosion_years >= 0),
  corrosion_miles integer CHECK (corrosion_miles IS NULL OR corrosion_miles >= 0),
  roadside_years smallint CHECK (roadside_years IS NULL OR roadside_years >= 0),
  roadside_miles integer CHECK (roadside_miles IS NULL OR roadside_miles >= 0),
  notes text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'provider', 'import')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.media_processing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  media_category text NOT NULL CHECK (media_category IN ('exterior', 'interior', 'detail', 'odometer', 'vin', 'document', 'misc')),
  action text NOT NULL CHECK (action IN ('keep_original', 'enhance', 'background_replace', 'background_merchandising', 'manual_review')),
  template_id uuid,
  enabled boolean NOT NULL DEFAULT true,
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dealership_id, media_category)
);

INSERT INTO public.media_processing_rules (dealership_id, media_category, action, priority)
SELECT d.id, category, CASE WHEN category = 'exterior' THEN 'manual_review' ELSE 'keep_original' END, 0
FROM public.dealerships AS d
CROSS JOIN unnest(ARRAY['exterior','interior','detail','odometer','vin','document','misc']) AS category
ON CONFLICT (dealership_id, media_category) DO NOTHING;

ALTER TABLE public.photos
  ADD COLUMN media_kind text NOT NULL DEFAULT 'photo'
    CHECK (media_kind IN ('photo', 'video', 'exterior_360', 'interior_360')),
  ADD COLUMN media_category text NOT NULL DEFAULT 'misc'
    CHECK (media_category IN ('exterior', 'interior', 'detail', 'odometer', 'vin', 'document', 'misc')),
  ADD COLUMN processing_action text NOT NULL DEFAULT 'keep_original'
    CHECK (processing_action IN ('keep_original', 'enhance', 'background_replace', 'background_merchandising', 'manual_review')),
  ADD COLUMN processing_provider text,
  ADD COLUMN processing_status text NOT NULL DEFAULT 'not_required'
    CHECK (processing_status IN ('not_required', 'queued', 'processing', 'completed', 'failed')),
  ADD COLUMN processing_error text,
  ADD COLUMN review_status text NOT NULL DEFAULT 'unreviewed'
    CHECK (review_status IN ('unreviewed', 'awaiting_review', 'approved', 'rejected')),
  ADD COLUMN publication_status text NOT NULL DEFAULT 'unpublished'
    CHECK (publication_status IN ('unpublished', 'pending', 'published', 'failed')),
  ADD COLUMN quality_issues jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(quality_issues) = 'array' AND octet_length(quality_issues::text) <= 32768),
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 65536),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.photos
SET media_category = CASE
  WHEN lower(coalesce(shot_type, '')) LIKE '%interior%' OR lower(coalesce(shot_type, '')) IN ('dashboard','front seats','rear seats','infotainment','steering wheel','instrument cluster','center console','cargo','door controls') THEN 'interior'
  WHEN lower(coalesce(shot_type, '')) LIKE '%odometer%' THEN 'odometer'
  WHEN lower(coalesce(shot_type, '')) = 'vin' THEN 'vin'
  WHEN lower(coalesce(shot_type, '')) IN ('front','rear','driver side','passenger side','front 3/4','rear 3/4','wheel','engine bay') THEN 'exterior'
  ELSE 'misc'
END,
processing_action = 'keep_original',
processing_status = CASE WHEN photo_state = 'raw' THEN 'not_required' ELSE 'completed' END;

CREATE OR REPLACE FUNCTION private.classify_captured_photo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_label text := lower(coalesce(NEW.shot_type, ''));
BEGIN
  IF NEW.media_category = 'misc' THEN
    NEW.media_category := CASE
      WHEN normalized_label LIKE '%interior%'
        OR normalized_label IN ('dashboard','seats','front seats','rear seats','infotainment','steering wheel','instrument cluster','center console','cargo','trunk','door controls')
        THEN 'interior'
      WHEN normalized_label LIKE '%odometer%' THEN 'odometer'
      WHEN normalized_label = 'vin' THEN 'vin'
      WHEN normalized_label IN ('front','rear','driver side','passenger side','front 3/4','rear 3/4','wheel','engine','engine bay')
        THEN 'exterior'
      ELSE 'misc'
    END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Capture is intentionally cheap: classification is recorded, but no
    -- background-removal or rendering work is queued automatically.
    NEW.processing_action := 'keep_original';
    NEW.processing_status := 'not_required';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER photos_classify_capture
BEFORE INSERT OR UPDATE OF shot_type ON public.photos
FOR EACH ROW EXECUTE FUNCTION private.classify_captured_photo();

REVOKE ALL ON FUNCTION private.classify_captured_photo()
FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX photos_vehicle_media_idx
  ON public.photos (vehicle_id, media_kind, media_category, sort_order, created_at);
CREATE INDEX photos_processing_queue_idx
  ON public.photos (processing_status, updated_at)
  WHERE processing_status IN ('queued', 'processing', 'failed');
CREATE INDEX photos_review_queue_idx
  ON public.photos (review_status, updated_at)
  WHERE review_status IN ('awaiting_review', 'rejected');

CREATE TABLE public.media_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id uuid NOT NULL REFERENCES public.photos(id) ON DELETE CASCADE,
  variant_type text NOT NULL CHECK (variant_type IN ('original', 'cutout', 'corrected_cutout', 'customized', 'enhanced', 'published')),
  source_variant_id uuid REFERENCES public.media_variants(id) ON DELETE SET NULL,
  image_url text NOT NULL,
  storage_path text,
  processing_provider text,
  processing_status text NOT NULL DEFAULT 'completed'
    CHECK (processing_status IN ('queued', 'processing', 'completed', 'failed')),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  checksum text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 65536),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX media_variants_original_once_idx
  ON public.media_variants (photo_id) WHERE variant_type = 'original';
CREATE INDEX media_variants_photo_created_idx
  ON public.media_variants (photo_id, created_at DESC);
CREATE INDEX media_variants_source_idx
  ON public.media_variants (source_variant_id) WHERE source_variant_id IS NOT NULL;
CREATE INDEX media_variants_created_by_idx
  ON public.media_variants (created_by, created_at DESC) WHERE created_by IS NOT NULL;

INSERT INTO public.media_variants (photo_id, variant_type, image_url, processing_status, created_at)
SELECT p.id, 'original', p.original_image_url, 'completed', p.created_at
FROM public.photos AS p
ON CONFLICT (photo_id) WHERE variant_type = 'original' DO NOTHING;

INSERT INTO public.media_variants (photo_id, variant_type, image_url, processing_status, created_at)
SELECT p.id,
       CASE p.photo_state WHEN 'customized' THEN 'customized' ELSE 'cutout' END,
       p.image_url, 'completed', p.updated_at
FROM public.photos AS p
WHERE p.image_url IS DISTINCT FROM p.original_image_url;

ALTER TABLE public.photos
  ADD COLUMN approved_variant_id uuid REFERENCES public.media_variants(id) ON DELETE SET NULL;

UPDATE public.photos AS p
SET approved_variant_id = (
  SELECT mv.id
  FROM public.media_variants AS mv
  WHERE mv.photo_id = p.id
  ORDER BY (mv.image_url = p.image_url) DESC, mv.created_at DESC
  LIMIT 1
);

CREATE INDEX photos_approved_variant_idx
  ON public.photos (approved_variant_id) WHERE approved_variant_id IS NOT NULL;

-- Every newly uploaded asset receives an immutable original lineage row. The
-- trigger runs with table-owner privileges because browsers cannot be trusted
-- to create or identify the canonical original variant themselves.
CREATE OR REPLACE FUNCTION private.preserve_photo_original_variant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.media_variants
    (photo_id, variant_type, image_url, processing_status, created_at)
  VALUES
    (NEW.id, 'original', NEW.original_image_url, 'completed', NEW.created_at)
  ON CONFLICT (photo_id) WHERE variant_type = 'original' DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER photos_preserve_original_variant
AFTER INSERT ON public.photos
FOR EACH ROW EXECUTE FUNCTION private.preserve_photo_original_variant();

REVOKE ALL ON FUNCTION private.preserve_photo_original_variant()
FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.photo_capture_sessions
  ADD COLUMN started_at timestamptz,
  ADD COLUMN shoot_type text NOT NULL DEFAULT 'standard'
    CHECK (shoot_type IN ('standard', 'reshoot', 'bulk')),
  ADD COLUMN reshoot_of uuid REFERENCES public.photo_capture_sessions(id) ON DELETE SET NULL,
  ADD COLUMN duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  ADD COLUMN photo_count integer NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
  ADD COLUMN video_count integer NOT NULL DEFAULT 0 CHECK (video_count >= 0),
  ADD COLUMN exterior_count integer NOT NULL DEFAULT 0 CHECK (exterior_count >= 0),
  ADD COLUMN interior_count integer NOT NULL DEFAULT 0 CHECK (interior_count >= 0),
  ADD COLUMN detail_count integer NOT NULL DEFAULT 0 CHECK (detail_count >= 0),
  ADD COLUMN review_status text NOT NULL DEFAULT 'unreviewed'
    CHECK (review_status IN ('unreviewed', 'awaiting_review', 'approved', 'rejected')),
  ADD COLUMN notes text;

UPDATE public.photo_capture_sessions
SET started_at = created_at,
    shoot_type = CASE WHEN mode = 'bulk' THEN 'bulk' ELSE 'standard' END
WHERE started_at IS NULL;

ALTER TABLE public.photo_capture_sessions
  ALTER COLUMN started_at SET NOT NULL,
  ALTER COLUMN started_at SET DEFAULT now();

CREATE INDEX photo_capture_sessions_completed_report_idx
  ON public.photo_capture_sessions (dealership_id, completed_at DESC, completed_by)
  WHERE completed_at IS NOT NULL;
CREATE INDEX photo_capture_sessions_reshoot_idx
  ON public.photo_capture_sessions (reshoot_of) WHERE reshoot_of IS NOT NULL;
CREATE INDEX photo_capture_sessions_completed_by_idx
  ON public.photo_capture_sessions (completed_by, completed_at DESC) WHERE completed_by IS NOT NULL;

CREATE OR REPLACE FUNCTION private.current_user_store_role(_dealership_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN private.current_user_is_active_owner() THEN 'platform_admin'
    WHEN EXISTS (
      SELECT 1
      FROM public.organization_memberships AS om
      JOIN public.dealerships AS d ON d.organization_id = om.organization_id
      JOIN public.organizations AS o ON o.id = d.organization_id
      JOIN public.profiles AS p ON p.id = om.profile_id
      JOIN public.user_onboarding AS uo ON uo.profile_id = p.id
      WHERE om.profile_id = (SELECT auth.uid())
        AND d.id = _dealership_id
        AND om.role = 'group_admin'
        AND o.status = 'active'
        AND p.status = 'active'
        AND uo.onboarding_state = 'complete'
        AND uo.password_change_required = false
        AND d.status IN ('active', 'trial')
        AND d.subscription_status = 'active'
    ) THEN 'group_admin'
    ELSE (
      SELECT CASE WHEN p.role = 'dealer_admin'::public.app_role
                  THEN 'dealer_admin' ELSE pd.access_role END
      FROM public.profile_dealerships AS pd
      JOIN public.profiles AS p ON p.id = pd.profile_id
      WHERE pd.profile_id = (SELECT auth.uid())
        AND pd.dealership_id = _dealership_id
        AND private.current_user_has_active_membership(pd.dealership_id)
      LIMIT 1
    )
  END;
$$;

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
    WHEN 'store_manager' THEN _capability = ANY (ARRAY['inventory','media','documents','reports','settings'])
    WHEN 'inventory_media' THEN _capability = ANY (ARRAY['inventory','media','documents'])
    WHEN 'photographer' THEN _capability = ANY (ARRAY['inventory_read','capture','self_reports'])
    WHEN 'accounting' THEN _capability = ANY (ARRAY['reports','payout_status'])
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION private.current_user_can_manage_vehicle_details(_vehicle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.vehicles AS v
    WHERE v.id = _vehicle_id
      AND private.current_user_has_store_capability(v.dealership_id, 'inventory')
  );
$$;

-- Organization suspension contains every store membership without changing
-- the long-standing active-owner recovery path.
CREATE OR REPLACE FUNCTION private.current_user_has_active_membership(_dealership_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT private.current_user_is_active_owner())
    OR EXISTS (
      SELECT 1
      FROM public.profiles AS p
      JOIN public.user_onboarding AS uo ON uo.profile_id = p.id
      JOIN public.profile_dealerships AS pd ON pd.profile_id = p.id
      JOIN public.dealerships AS d ON d.id = pd.dealership_id
      JOIN public.organizations AS o ON o.id = d.organization_id
      WHERE p.id = (SELECT auth.uid())
        AND p.status = 'active'
        AND p.role <> 'owner'::public.app_role
        AND uo.onboarding_state = 'complete'
        AND uo.password_change_required = false
        AND pd.dealership_id = _dealership_id
        AND (p.role = 'dealer_admin'::public.app_role OR p.dealership_id = pd.dealership_id)
        AND d.status IN ('active', 'trial')
        AND d.subscription_status = 'active'
        AND o.status = 'active'
    )
    OR EXISTS (
      SELECT 1
      FROM public.organization_memberships AS om
      JOIN public.profiles AS p ON p.id = om.profile_id
      JOIN public.user_onboarding AS uo ON uo.profile_id = p.id
      JOIN public.dealerships AS d ON d.organization_id = om.organization_id
      JOIN public.organizations AS o ON o.id = d.organization_id
      WHERE om.profile_id = (SELECT auth.uid())
        AND om.role = 'group_admin'
        AND d.id = _dealership_id
        AND p.status = 'active'
        AND uo.onboarding_state = 'complete'
        AND uo.password_change_required = false
        AND d.status IN ('active', 'trial')
        AND d.subscription_status = 'active'
        AND o.status = 'active'
    );
$$;

REVOKE ALL ON FUNCTION private.current_user_store_role(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_has_store_capability(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_user_can_manage_vehicle_details(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.current_user_store_role(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_has_store_capability(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_can_manage_vehicle_details(uuid) TO authenticated;

DROP POLICY "Active members insert overlays" ON public.overlay_templates;
DROP POLICY "Active members update overlays" ON public.overlay_templates;
DROP POLICY "Active members delete overlays" ON public.overlay_templates;
CREATE POLICY "Media users insert overlays"
ON public.overlay_templates FOR INSERT TO authenticated
WITH CHECK (private.current_user_has_store_capability(dealership_id, 'media'));
CREATE POLICY "Media users update overlays"
ON public.overlay_templates FOR UPDATE TO authenticated
USING (private.current_user_has_store_capability(dealership_id, 'media'))
WITH CHECK (private.current_user_has_store_capability(dealership_id, 'media'));
CREATE POLICY "Media users delete overlays"
ON public.overlay_templates FOR DELETE TO authenticated
USING (private.current_user_has_store_capability(dealership_id, 'media'));

DROP POLICY "Active members insert backdrops" ON public.backdrops;
DROP POLICY "Active members update backdrops" ON public.backdrops;
DROP POLICY "Active members delete backdrops" ON public.backdrops;
CREATE POLICY "Media users insert backdrops"
ON public.backdrops FOR INSERT TO authenticated
WITH CHECK (private.current_user_has_store_capability(dealership_id, 'media'));
CREATE POLICY "Media users update backdrops"
ON public.backdrops FOR UPDATE TO authenticated
USING (private.current_user_has_store_capability(dealership_id, 'media'))
WITH CHECK (private.current_user_has_store_capability(dealership_id, 'media'));
CREATE POLICY "Media users delete backdrops"
ON public.backdrops FOR DELETE TO authenticated
USING (private.current_user_has_store_capability(dealership_id, 'media'));

DROP POLICY "Active members insert documents" ON public.documents;
DROP POLICY "Active members update documents" ON public.documents;
DROP POLICY "Active members delete documents" ON public.documents;
CREATE POLICY "Document users insert documents"
ON public.documents FOR INSERT TO authenticated
WITH CHECK (private.current_user_has_store_capability(dealership_id, 'documents'));
CREATE POLICY "Document users update documents"
ON public.documents FOR UPDATE TO authenticated
USING (private.current_user_has_store_capability(dealership_id, 'documents'))
WITH CHECK (private.current_user_has_store_capability(dealership_id, 'documents'));
CREATE POLICY "Document users delete documents"
ON public.documents FOR DELETE TO authenticated
USING (private.current_user_has_store_capability(dealership_id, 'documents'));

DROP POLICY "Active members insert vehicles" ON public.vehicles;
DROP POLICY "Active members update vehicles" ON public.vehicles;
DROP POLICY "Active administrators delete vehicles" ON public.vehicles;
CREATE POLICY "Inventory users insert vehicles"
ON public.vehicles FOR INSERT TO authenticated
WITH CHECK (private.current_user_has_store_capability(dealership_id, 'inventory'));
CREATE POLICY "Inventory users update vehicles"
ON public.vehicles FOR UPDATE TO authenticated
USING (private.current_user_has_active_membership(dealership_id))
WITH CHECK (private.current_user_has_store_capability(dealership_id, 'inventory'));
CREATE POLICY "Inventory administrators delete vehicles"
ON public.vehicles FOR DELETE TO authenticated
USING (private.current_user_has_store_capability(dealership_id, 'inventory'));

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_warranties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_processing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_variants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.organizations, public.organization_memberships,
  public.vehicle_equipment, public.vehicle_warranties,
  public.media_processing_rules, public.media_variants
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.organizations, public.organization_memberships,
  public.vehicle_equipment, public.vehicle_warranties,
  public.media_processing_rules, public.media_variants TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vehicle_equipment, public.vehicle_warranties TO authenticated;
GRANT INSERT ON public.media_variants TO authenticated;
REVOKE UPDATE (
  image_url, overlay_id, is_cutout, cutout_status, cutout_image_url,
  corrected_cutout_url, photo_state
) ON public.photos FROM authenticated;
GRANT UPDATE (media_category) ON public.photos TO authenticated;
GRANT ALL ON public.organizations, public.organization_memberships,
  public.vehicle_equipment, public.vehicle_warranties,
  public.media_processing_rules, public.media_variants TO service_role;

CREATE POLICY "Active users view permitted organizations"
ON public.organizations FOR SELECT TO authenticated
USING (
  private.current_user_is_active_owner()
  OR EXISTS (
    SELECT 1 FROM public.dealerships AS d
    WHERE d.organization_id = organizations.id
      AND private.current_user_has_active_membership(d.id)
  )
);

CREATE POLICY "Active users view own organization memberships"
ON public.organization_memberships FOR SELECT TO authenticated
USING (
  private.current_user_is_active_owner()
  OR profile_id = (SELECT auth.uid())
);

CREATE POLICY "Active members view vehicle equipment"
ON public.vehicle_equipment FOR SELECT TO authenticated
USING (private.current_user_can_access_vehicle(vehicle_id));
CREATE POLICY "Inventory users insert vehicle equipment"
ON public.vehicle_equipment FOR INSERT TO authenticated
WITH CHECK (private.current_user_can_manage_vehicle_details(vehicle_id));
CREATE POLICY "Inventory users update vehicle equipment"
ON public.vehicle_equipment FOR UPDATE TO authenticated
USING (private.current_user_can_manage_vehicle_details(vehicle_id))
WITH CHECK (private.current_user_can_manage_vehicle_details(vehicle_id));
CREATE POLICY "Inventory users delete vehicle equipment"
ON public.vehicle_equipment FOR DELETE TO authenticated
USING (private.current_user_can_manage_vehicle_details(vehicle_id));

CREATE POLICY "Active members view vehicle warranties"
ON public.vehicle_warranties FOR SELECT TO authenticated
USING (private.current_user_can_access_vehicle(vehicle_id));
CREATE POLICY "Inventory users insert vehicle warranties"
ON public.vehicle_warranties FOR INSERT TO authenticated
WITH CHECK (private.current_user_can_manage_vehicle_details(vehicle_id));
CREATE POLICY "Inventory users update vehicle warranties"
ON public.vehicle_warranties FOR UPDATE TO authenticated
USING (private.current_user_can_manage_vehicle_details(vehicle_id))
WITH CHECK (private.current_user_can_manage_vehicle_details(vehicle_id));
CREATE POLICY "Inventory users delete vehicle warranties"
ON public.vehicle_warranties FOR DELETE TO authenticated
USING (private.current_user_can_manage_vehicle_details(vehicle_id));

CREATE POLICY "Active members view media processing rules"
ON public.media_processing_rules FOR SELECT TO authenticated
USING (private.current_user_has_active_membership(dealership_id));

CREATE POLICY "Active members view media variants"
ON public.media_variants FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.photos AS p
  WHERE p.id = media_variants.photo_id
    AND private.current_user_can_access_vehicle(p.vehicle_id)
));
CREATE POLICY "Active media users create media variants"
ON public.media_variants FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.photos AS p
  WHERE p.id = media_variants.photo_id
    AND private.current_user_can_access_vehicle(p.vehicle_id)
    AND created_by = (SELECT auth.uid())
));

-- Preserve existing direct update compatibility while exposing only the new
-- non-authorization media workflow columns.
REVOKE UPDATE ON public.photos FROM authenticated;
GRANT UPDATE (
  image_url, shot_type, overlay_id, sort_order, is_main, is_cutout,
  cutout_status, cutout_image_url, corrected_cutout_url, photo_state,
  media_kind, media_category, processing_action, processing_provider,
  processing_status, processing_error, review_status, publication_status,
  quality_issues, metadata, approved_variant_id, updated_at
) ON public.photos TO authenticated;
