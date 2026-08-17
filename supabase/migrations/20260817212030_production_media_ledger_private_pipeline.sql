-- DealerShot production media ledger and private rendering foundation.
-- Physical object copies are performed through the Storage API by the worker;
-- this migration only establishes durable identities, authorization and jobs.

CREATE TABLE public.media_assets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE RESTRICT,
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  capture_session_id uuid REFERENCES public.photo_capture_sessions(id) ON DELETE SET NULL,
  source_media_id uuid REFERENCES public.media_assets(id) ON DELETE SET NULL,
  uploaded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  source_type text NOT NULL DEFAULT 'capture'
    CHECK (source_type IN ('capture','upload','bulk','legacy','retake','derived')),
  media_kind text NOT NULL DEFAULT 'photo'
    CHECK (media_kind IN ('photo','video','exterior_360','interior_360')),
  media_category text NOT NULL DEFAULT 'misc'
    CHECK (media_category IN ('exterior','interior','detail','odometer','vin','document','misc')),
  shot_label text,
  original_filename text,
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  storage_provider text NOT NULL DEFAULT 'supabase',
  storage_bucket text NOT NULL,
  storage_object_path text NOT NULL,
  lifecycle_state text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active','superseded','archived')),
  migration_state text NOT NULL DEFAULT 'private'
    CHECK (migration_state IN ('legacy','copying','verified','private','failed')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_bucket, storage_object_path),
  CHECK ((lifecycle_state = 'archived') = (archived_at IS NOT NULL)),
  CHECK (vehicle_id IS NOT NULL OR capture_session_id IS NOT NULL)
);

CREATE INDEX media_assets_store_created_idx
  ON public.media_assets (dealership_id, created_at DESC);
CREATE INDEX media_assets_vehicle_order_idx
  ON public.media_assets (vehicle_id, created_at DESC) WHERE vehicle_id IS NOT NULL;
CREATE INDEX media_assets_session_idx
  ON public.media_assets (capture_session_id, created_at DESC) WHERE capture_session_id IS NOT NULL;
CREATE INDEX media_assets_checksum_idx
  ON public.media_assets (dealership_id, checksum_sha256);
CREATE INDEX media_assets_source_idx
  ON public.media_assets (source_media_id) WHERE source_media_id IS NOT NULL;

CREATE OR REPLACE FUNCTION private.classify_media_category(_shot_label text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN lower(trim(COALESCE(_shot_label,''))) IN (
      'front','rear','driver side','passenger side','front 3/4','rear 3/4',
      'front driver 3/4','rear driver 3/4','rear passenger 3/4',
      'front passenger 3/4','wheel','engine bay'
    ) THEN 'exterior'
    WHEN lower(trim(COALESCE(_shot_label,''))) IN (
      'dashboard','front seats','rear seats','infotainment','steering wheel',
      'steering wheel / cluster','instrument cluster','center console','cargo',
      'door controls'
    ) THEN 'interior'
    WHEN lower(trim(COALESCE(_shot_label,''))) = 'odometer' THEN 'odometer'
    WHEN lower(trim(COALESCE(_shot_label,''))) = 'vin' THEN 'vin'
    WHEN lower(trim(COALESCE(_shot_label,''))) LIKE '%detail%' THEN 'detail'
    ELSE 'misc'
  END;
$$;

REVOKE ALL ON FUNCTION private.classify_media_category(text)
FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.photos ADD COLUMN media_asset_id uuid REFERENCES public.media_assets(id) ON DELETE RESTRICT;
ALTER TABLE public.bulk_photo_items ADD COLUMN media_asset_id uuid REFERENCES public.media_assets(id) ON DELETE RESTRICT;
ALTER TABLE public.media_variants
  ALTER COLUMN photo_id DROP NOT NULL,
  ADD COLUMN media_asset_id uuid REFERENCES public.media_assets(id) ON DELETE RESTRICT,
  ADD COLUMN storage_bucket text,
  ADD COLUMN content_type text,
  ADD COLUMN original_filename text,
  ADD COLUMN variant_role text,
  ADD COLUMN archived_at timestamptz;

ALTER TABLE public.media_variants DROP CONSTRAINT media_variants_photo_id_fkey;
ALTER TABLE public.media_variants ADD CONSTRAINT media_variants_photo_id_fkey
  FOREIGN KEY (photo_id) REFERENCES public.photos(id) ON DELETE SET NULL;

ALTER TABLE public.media_variants DROP CONSTRAINT media_variants_variant_type_check;
ALTER TABLE public.media_variants ADD CONSTRAINT media_variants_variant_type_check
  CHECK (variant_type IN (
    'original','thumbnail','preview','cutout','corrected_cutout','customized',
    'enhanced','dealer_render','published'
  ));

CREATE UNIQUE INDEX media_variants_storage_object_idx
  ON public.media_variants (storage_bucket, storage_path)
  WHERE storage_bucket IS NOT NULL AND storage_path IS NOT NULL;
CREATE INDEX media_variants_asset_created_idx
  ON public.media_variants (media_asset_id, created_at DESC)
  WHERE media_asset_id IS NOT NULL;
CREATE INDEX media_variants_asset_role_idx
  ON public.media_variants (media_asset_id, variant_role, created_at DESC)
  WHERE media_asset_id IS NOT NULL AND variant_role IS NOT NULL AND archived_at IS NULL;

-- Create one logical asset per existing photo without changing historical URLs.
INSERT INTO public.media_assets (
  id, organization_id, dealership_id, vehicle_id, capture_session_id, uploaded_by,
  source_type, media_kind, media_category, shot_label, original_filename,
  content_type, byte_size, width, height, checksum_sha256,
  storage_bucket, storage_object_path, migration_state, created_at, updated_at
)
SELECT
  gen_random_uuid(), d.organization_id, v.dealership_id, p.vehicle_id,
  p.capture_session_id, pcs.created_by,
  'legacy', p.media_kind, p.media_category, p.shot_type,
  regexp_replace(COALESCE(mv.storage_path, p.original_image_url), '^.*/', ''),
  COALESCE(NULLIF(mv.metadata->>'mimetype', ''), 'application/octet-stream'),
  COALESCE(mv.byte_size, 0), mv.width, mv.height,
  COALESCE(NULLIF(lower(mv.checksum), ''), repeat('0', 64)),
  'vehicle-photos',
  COALESCE(mv.storage_path, NULLIF(split_part(split_part(p.original_image_url,
    '/vehicle-photos/', 2), '?', 1), ''), 'unresolved/' || p.id),
  'legacy', p.created_at, p.updated_at
FROM public.photos AS p
JOIN public.vehicles AS v ON v.id = p.vehicle_id
JOIN public.dealerships AS d ON d.id = v.dealership_id
LEFT JOIN public.photo_capture_sessions AS pcs ON pcs.id = p.capture_session_id
LEFT JOIN public.media_variants AS mv ON mv.photo_id = p.id AND mv.variant_type = 'original'
;

-- The uploaded_by cast above is deliberately corrected from session data only;
-- legacy rows without a session remain nullable.
UPDATE public.media_assets AS ma
SET uploaded_by = pcs.created_by
FROM public.photos AS p
LEFT JOIN public.photo_capture_sessions AS pcs ON pcs.id = p.capture_session_id
WHERE ma.vehicle_id = p.vehicle_id
  AND ma.storage_object_path = COALESCE(
    (SELECT mv.storage_path FROM public.media_variants mv
     WHERE mv.photo_id = p.id AND mv.variant_type = 'original' LIMIT 1),
    NULLIF(split_part(split_part(p.original_image_url, '/vehicle-photos/', 2), '?', 1), ''),
    'unresolved/' || p.id
  );

UPDATE public.photos AS p
SET media_asset_id = ma.id
FROM public.media_assets AS ma
WHERE ma.vehicle_id = p.vehicle_id
  AND ma.storage_object_path = COALESCE(
    (SELECT mv.storage_path FROM public.media_variants mv
     WHERE mv.photo_id = p.id AND mv.variant_type = 'original' LIMIT 1),
    NULLIF(split_part(split_part(p.original_image_url, '/vehicle-photos/', 2), '?', 1), ''),
    'unresolved/' || p.id
  );

UPDATE public.media_variants AS mv
SET media_asset_id = p.media_asset_id,
    storage_bucket = CASE WHEN mv.storage_path IS NOT NULL THEN 'vehicle-photos' ELSE NULL END,
    content_type = COALESCE(NULLIF(mv.metadata->>'mimetype', ''), 'application/octet-stream'),
    variant_role = CASE mv.variant_type
      WHEN 'original' THEN 'source'
      WHEN 'published' THEN 'published'
      ELSE 'prepared'
    END
FROM public.photos AS p
WHERE p.id = mv.photo_id;

CREATE OR REPLACE FUNCTION private.preserve_photo_original_variant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.media_variants
  SET photo_id = NEW.id
  WHERE media_asset_id = NEW.media_asset_id
    AND variant_type = 'original'
    AND photo_id IS NULL;
  IF FOUND THEN RETURN NEW; END IF;
  INSERT INTO public.media_variants
    (photo_id, media_asset_id, variant_type, image_url, processing_status, created_at)
  VALUES
    (NEW.id, NEW.media_asset_id, 'original', NEW.original_image_url, 'completed', NEW.created_at)
  ON CONFLICT (photo_id) WHERE variant_type = 'original' DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.preserve_photo_original_variant()
FROM PUBLIC, anon, authenticated, service_role;

CREATE UNIQUE INDEX media_variants_asset_original_once_idx
  ON public.media_variants (media_asset_id) WHERE variant_type = 'original';

-- Resumable copy/verification map. It remains private because legacy object
-- paths and rollback references are operational metadata, not UI data.
CREATE TABLE private.media_storage_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_variant_id uuid NOT NULL REFERENCES public.media_variants(id) ON DELETE CASCADE,
  media_asset_id uuid NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  source_bucket text NOT NULL,
  source_path text NOT NULL,
  destination_bucket text NOT NULL DEFAULT 'dealer-media-private',
  destination_path text NOT NULL,
  state text NOT NULL DEFAULT 'legacy'
    CHECK (state IN ('legacy','copying','verified','private','failed')),
  source_byte_size bigint,
  destination_byte_size bigint,
  source_checksum_sha256 text,
  destination_checksum_sha256 text,
  attempt_count integer NOT NULL DEFAULT 0,
  safe_error_code text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_bucket, source_path),
  UNIQUE (destination_bucket, destination_path)
);

CREATE INDEX media_storage_migrations_state_idx
  ON private.media_storage_migrations (state, updated_at);

INSERT INTO private.media_storage_migrations (
  media_variant_id, media_asset_id, source_bucket, source_path, destination_path
)
SELECT mv.id, mv.media_asset_id, 'vehicle-photos', mv.storage_path,
       'stores/' || ma.dealership_id || '/vehicles/' || ma.vehicle_id ||
       '/media/' || ma.id || '/' || mv.variant_type || '/' ||
       regexp_replace(mv.storage_path, '^.*/', '')
FROM public.media_variants AS mv
JOIN public.media_assets AS ma ON ma.id = mv.media_asset_id
WHERE mv.storage_path IS NOT NULL
  AND mv.storage_path NOT LIKE 'unresolved/%'
ON CONFLICT (source_bucket, source_path) DO NOTHING;

CREATE TABLE private.media_orphan_audit (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  bucket_id text NOT NULL,
  object_path text NOT NULL,
  byte_size bigint,
  content_type text,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  resolution text NOT NULL DEFAULT 'unresolved'
    CHECK (resolution IN ('unresolved','linked','retained','quarantined','deleted')),
  UNIQUE (bucket_id, object_path)
);

INSERT INTO private.media_orphan_audit (bucket_id, object_path, byte_size, content_type)
SELECT o.bucket_id, o.name,
       NULLIF(to_jsonb(o)->'metadata'->>'size','')::bigint,
       to_jsonb(o)->'metadata'->>'mimetype'
FROM storage.objects AS o
LEFT JOIN private.media_storage_migrations AS msm
  ON msm.source_bucket = o.bucket_id AND msm.source_path = o.name
WHERE o.bucket_id = 'vehicle-photos' AND msm.id IS NULL
ON CONFLICT (bucket_id, object_path) DO NOTHING;

REVOKE ALL ON private.media_storage_migrations, private.media_orphan_audit
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE private.media_orphan_audit_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.media_storage_migrations, private.media_orphan_audit TO service_role;
GRANT ALL ON SEQUENCE private.media_orphan_audit_id_seq TO service_role;

CREATE OR REPLACE FUNCTION private.current_user_can_access_media_asset(
  _media_asset_id uuid,
  _purpose text DEFAULT 'preview'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.media_assets AS ma
    WHERE ma.id = _media_asset_id
      AND ma.lifecycle_state <> 'archived'
      AND _purpose IN ('thumbnail','preview','original','editor','download')
      AND (
        private.current_user_has_store_capability(ma.dealership_id, 'media')
        OR (
          _purpose IN ('thumbnail','preview')
          AND
          private.current_user_has_store_capability(ma.dealership_id, 'capture')
          AND (
            ma.uploaded_by = (SELECT auth.uid())
            OR EXISTS (
              SELECT 1 FROM public.photo_capture_sessions AS pcs
              WHERE pcs.id = ma.capture_session_id
                AND (pcs.created_by = (SELECT auth.uid()) OR pcs.completed_by = (SELECT auth.uid()))
            )
          )
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION private.current_user_can_access_media_asset(uuid, text)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.current_user_can_access_media_asset(uuid, text)
TO anon, authenticated, service_role;

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_assets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.media_assets TO authenticated;
GRANT ALL ON public.media_assets TO service_role;

CREATE POLICY "Authorized users view media ledger"
ON public.media_assets FOR SELECT TO authenticated
USING (private.current_user_can_access_media_asset(id, 'preview'));

DROP POLICY "Active members view media variants" ON public.media_variants;
DROP POLICY "Active media users create media variants" ON public.media_variants;
REVOKE INSERT, UPDATE, DELETE ON public.media_variants FROM authenticated;
CREATE POLICY "Authorized users view private media variants"
ON public.media_variants FOR SELECT TO authenticated
USING (private.current_user_can_access_media_asset(media_asset_id, 'preview'));

CREATE OR REPLACE FUNCTION public.get_media_delivery_manifest(
  _media_asset_id uuid,
  _purpose text DEFAULT 'preview',
  _variant_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  asset public.media_assets%ROWTYPE;
  variant public.media_variants%ROWTYPE;
  photo public.photos%ROWTYPE;
BEGIN
  IF _purpose NOT IN ('thumbnail','preview','original','editor','download') THEN
    RAISE EXCEPTION 'Unsupported media purpose.' USING ERRCODE = '22023';
  END IF;
  IF NOT private.current_user_can_access_media_asset(_media_asset_id, _purpose) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO asset FROM public.media_assets WHERE id = _media_asset_id;
  SELECT * INTO photo FROM public.photos WHERE media_asset_id = asset.id LIMIT 1;

  IF _variant_id IS NOT NULL THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE id = _variant_id AND media_asset_id = asset.id AND archived_at IS NULL;
  ELSIF _purpose = 'thumbnail' THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE media_asset_id = asset.id AND variant_type = 'thumbnail' AND archived_at IS NULL
    ORDER BY width ASC NULLS LAST, created_at DESC LIMIT 1;
  ELSIF _purpose = 'preview' THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE media_asset_id = asset.id AND variant_type IN ('preview','thumbnail') AND archived_at IS NULL
    ORDER BY (variant_type = 'preview') DESC, width DESC NULLS LAST, created_at DESC LIMIT 1;
  ELSIF _purpose = 'original' THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE media_asset_id = asset.id AND variant_type = 'original' AND archived_at IS NULL
    ORDER BY created_at LIMIT 1;
  END IF;

  IF variant.id IS NULL AND photo.approved_variant_id IS NOT NULL THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE id = photo.approved_variant_id AND media_asset_id = asset.id AND archived_at IS NULL;
  END IF;
  IF variant.id IS NULL THEN
    SELECT * INTO variant FROM public.media_variants
    WHERE media_asset_id = asset.id AND variant_type = 'original' AND archived_at IS NULL
    ORDER BY created_at LIMIT 1;
  END IF;
  IF variant.id IS NULL AND asset.storage_bucket IS NOT NULL AND asset.storage_object_path IS NOT NULL THEN
    RETURN jsonb_build_object(
      'media_asset_id', asset.id,
      'dealership_id', asset.dealership_id,
      'vehicle_id', asset.vehicle_id,
      'variant_id', NULL,
      'bucket', asset.storage_bucket,
      'path', asset.storage_object_path,
      'content_type', asset.content_type,
      'variant_type', 'original',
      'width', asset.width,
      'height', asset.height,
      'byte_size', asset.byte_size
    );
  ELSIF variant.id IS NULL OR variant.storage_bucket IS NULL OR variant.storage_path IS NULL THEN
    RAISE EXCEPTION 'Media derivative is not available.' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'media_asset_id', asset.id,
    'dealership_id', asset.dealership_id,
    'vehicle_id', asset.vehicle_id,
    'variant_id', variant.id,
    'bucket', variant.storage_bucket,
    'path', variant.storage_path,
    'content_type', variant.content_type,
    'variant_type', variant.variant_type,
    'width', variant.width,
    'height', variant.height,
    'byte_size', variant.byte_size
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_media_delivery_manifest(uuid, text, uuid)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_media_delivery_manifest(uuid, text, uuid)
TO authenticated;

CREATE OR REPLACE FUNCTION public.get_media_delivery_manifests(
  _media_asset_ids uuid[],
  _purpose text DEFAULT 'preview'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  asset_id uuid;
  result jsonb := '[]'::jsonb;
BEGIN
  IF COALESCE(array_length(_media_asset_ids,1),0) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Request between 1 and 100 media assets.' USING ERRCODE='22023';
  END IF;
  FOREACH asset_id IN ARRAY _media_asset_ids LOOP
    result := result || jsonb_build_array(
      public.get_media_delivery_manifest(asset_id, _purpose, NULL)
    );
  END LOOP;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_media_delivery_manifests(uuid[], text)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_media_delivery_manifests(uuid[], text) TO authenticated;

CREATE OR REPLACE FUNCTION private.actor_can_upload_media(
  _actor_id uuid,
  _dealership_id uuid,
  _vehicle_id uuid,
  _capture_session_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.actor_is_active_owner(_actor_id)
    OR private.actor_is_active_dealer_admin_for(_actor_id, _dealership_id)
    OR EXISTS (
      SELECT 1
      FROM public.profile_dealerships AS pd
      JOIN public.profiles AS p ON p.id = pd.profile_id
      JOIN public.user_onboarding AS uo ON uo.profile_id = p.id
      WHERE pd.profile_id = _actor_id
        AND pd.dealership_id = _dealership_id
        AND p.status = 'active'
        AND uo.onboarding_state = 'complete'
        AND uo.password_change_required = false
        AND pd.access_role IN ('store_manager','inventory_media','photographer')
        AND (
          (_vehicle_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.vehicles v
            WHERE v.id = _vehicle_id AND v.dealership_id = _dealership_id
          ))
          OR (_capture_session_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.photo_capture_sessions pcs
            WHERE pcs.id = _capture_session_id
              AND pcs.dealership_id = _dealership_id
              AND (pd.access_role <> 'photographer' OR pcs.created_by = _actor_id)
          ))
        )
    );
$$;

REVOKE ALL ON FUNCTION private.actor_can_upload_media(uuid, uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_media_upload_scope(
  _vehicle_id uuid DEFAULT NULL,
  _capture_session_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  store_id uuid;
  organization_id uuid;
  session public.photo_capture_sessions%ROWTYPE;
BEGIN
  IF (_vehicle_id IS NULL) = (_capture_session_id IS NULL) THEN
    RAISE EXCEPTION 'Provide exactly one upload target.' USING ERRCODE='22023';
  END IF;
  IF _vehicle_id IS NOT NULL THEN
    SELECT v.dealership_id, d.organization_id INTO store_id, organization_id
    FROM public.vehicles v JOIN public.dealerships d ON d.id=v.dealership_id
    WHERE v.id=_vehicle_id;
    IF store_id IS NULL OR NOT (
      private.current_user_has_store_capability(store_id,'media')
      OR private.current_user_has_store_capability(store_id,'capture')
    ) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('dealership_id',store_id,'organization_id',organization_id,
      'vehicle_id',_vehicle_id,'capture_session_id',NULL,'mode','vehicle');
  END IF;

  SELECT * INTO session FROM public.photo_capture_sessions
  WHERE id=_capture_session_id AND mode='bulk' AND status='in_progress';
  IF session.id IS NULL OR NOT (
    private.current_user_has_store_capability(session.dealership_id,'media')
    OR (
      private.current_user_has_store_capability(session.dealership_id,'capture')
      AND session.created_by=(SELECT auth.uid())
    )
  ) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  SELECT d.organization_id INTO organization_id FROM public.dealerships d
  WHERE d.id=session.dealership_id;
  RETURN jsonb_build_object('dealership_id',session.dealership_id,
    'organization_id',organization_id,'vehicle_id',session.vehicle_id,
    'capture_session_id',session.id,'mode','bulk');
END;
$$;

REVOKE ALL ON FUNCTION public.get_media_upload_scope(uuid, uuid)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_media_upload_scope(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.finalize_private_photo_upload(
  _actor_id uuid,
  _media_asset_id uuid,
  _vehicle_id uuid,
  _capture_session_id uuid,
  _storage_bucket text,
  _storage_path text,
  _original_filename text,
  _content_type text,
  _byte_size bigint,
  _width integer,
  _height integer,
  _checksum_sha256 text,
  _shot_label text,
  _sort_order integer,
  _source_type text DEFAULT 'capture'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  vehicle public.vehicles%ROWTYPE;
  store public.dealerships%ROWTYPE;
  new_photo_id uuid := gen_random_uuid();
  new_variant_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO vehicle FROM public.vehicles WHERE id = _vehicle_id;
  IF vehicle.id IS NULL THEN RAISE EXCEPTION 'Vehicle not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO store FROM public.dealerships WHERE id = vehicle.dealership_id;
  IF NOT private.actor_can_upload_media(_actor_id, store.id, vehicle.id, _capture_session_id) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF _storage_bucket <> 'dealer-media-private'
     OR _storage_path NOT LIKE 'stores/' || store.id || '/vehicles/' || vehicle.id || '/media/' || _media_asset_id || '/original/%'
     OR _content_type NOT IN ('image/jpeg','image/png','image/webp')
     OR _byte_size NOT BETWEEN 1 AND 26214400
     OR _checksum_sha256 !~ '^[0-9a-f]{64}$'
     OR _sort_order < 0 THEN
    RAISE EXCEPTION 'Invalid private media finalization.' USING ERRCODE = '22023';
  END IF;
  IF _capture_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.photo_capture_sessions pcs
    WHERE pcs.id = _capture_session_id AND pcs.dealership_id = store.id
      AND (pcs.vehicle_id IS NULL OR pcs.vehicle_id = vehicle.id)
  ) THEN RAISE EXCEPTION 'Capture session mismatch.' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.media_assets (
    id, organization_id, dealership_id, vehicle_id, capture_session_id, uploaded_by,
    source_type, media_kind, media_category, shot_label, original_filename,
    content_type, byte_size, width, height, checksum_sha256,
    storage_bucket, storage_object_path, migration_state
  ) VALUES (
    _media_asset_id, store.organization_id, store.id, vehicle.id, _capture_session_id, _actor_id,
    _source_type, 'photo', private.classify_media_category(_shot_label), _shot_label,
    left(_original_filename, 255), _content_type, _byte_size, _width, _height,
    _checksum_sha256, _storage_bucket, _storage_path, 'private'
  );

  INSERT INTO public.photos (
    id, vehicle_id, image_url, original_image_url, shot_type, sort_order,
    capture_session_id, photo_state, is_cutout, cutout_status, media_category,
    processing_action, processing_status, review_status, media_asset_id
  ) VALUES (
    new_photo_id, vehicle.id, 'private-media://' || new_variant_id, 'private-media://' || new_variant_id,
    _shot_label, _sort_order, _capture_session_id, 'raw', false, 'none',
    private.classify_media_category(_shot_label), 'keep_original', 'not_required',
    'unreviewed', _media_asset_id
  );

  -- Replace the compatibility trigger's row with the trusted storage-backed row.
  DELETE FROM public.media_variants
  WHERE photo_id = new_photo_id AND variant_type = 'original';
  INSERT INTO public.media_variants (
    id, photo_id, media_asset_id, variant_type, image_url, storage_bucket, storage_path,
    content_type, original_filename, processing_status, width, height, byte_size,
    checksum, variant_role, created_by
  ) VALUES (
    new_variant_id, new_photo_id, _media_asset_id, 'original', 'private-media://' || new_variant_id,
    _storage_bucket, _storage_path, _content_type, left(_original_filename,255),
    'completed', _width, _height, _byte_size, _checksum_sha256, 'source', _actor_id
  );
  UPDATE public.photos SET approved_variant_id = new_variant_id WHERE id = new_photo_id;

  INSERT INTO private.background_jobs (
    job_type, payload, dealership_id, resource_type, resource_id, dedupe_key,
    max_attempts, priority, created_by
  ) VALUES (
    'media.thumbnail.generate', jsonb_build_object('media_asset_id', _media_asset_id),
    store.id, 'media_asset', _media_asset_id, 'thumbnail:' || _media_asset_id,
    4, 20, _actor_id
  ) ON CONFLICT (job_type, dedupe_key) DO NOTHING;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('vehicle_media.original_finalized', _actor_id, store.id,
          jsonb_build_object('vehicle_id', vehicle.id, 'photo_id', new_photo_id,
                             'media_asset_id', _media_asset_id));
  RETURN jsonb_build_object('photo_id', new_photo_id, 'media_asset_id', _media_asset_id,
                            'variant_id', new_variant_id);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_private_photo_upload(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, integer, integer,
  text, text, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_private_photo_upload(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, integer, integer,
  text, text, integer, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_private_bulk_upload(
  _actor_id uuid,
  _media_asset_id uuid,
  _session_id uuid,
  _storage_bucket text,
  _storage_path text,
  _original_filename text,
  _content_type text,
  _byte_size bigint,
  _width integer,
  _height integer,
  _checksum_sha256 text,
  _sort_order integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  session public.photo_capture_sessions%ROWTYPE;
  store public.dealerships%ROWTYPE;
  item_id uuid := gen_random_uuid();
  variant_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO session FROM public.photo_capture_sessions WHERE id = _session_id;
  IF session.id IS NULL OR session.mode <> 'bulk' OR session.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Bulk session is not accepting media.' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO store FROM public.dealerships WHERE id = session.dealership_id;
  IF NOT private.actor_can_upload_media(_actor_id, store.id, session.vehicle_id, session.id) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF _storage_bucket <> 'dealer-media-private'
     OR _storage_path NOT LIKE 'stores/' || store.id || '/sessions/' || session.id || '/media/' || _media_asset_id || '/original/%'
     OR _content_type NOT IN ('image/jpeg','image/png','image/webp')
     OR _byte_size NOT BETWEEN 1 AND 26214400
     OR _checksum_sha256 !~ '^[0-9a-f]{64}$'
     OR _sort_order < 0 THEN
    RAISE EXCEPTION 'Invalid private media finalization.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.media_assets (
    id, organization_id, dealership_id, vehicle_id, capture_session_id, uploaded_by,
    source_type, media_kind, media_category, original_filename, content_type,
    byte_size, width, height, checksum_sha256, storage_bucket, storage_object_path,
    migration_state
  ) VALUES (
    _media_asset_id, store.organization_id, store.id, session.vehicle_id, session.id,
    _actor_id, 'bulk', 'photo', 'misc', left(_original_filename,255), _content_type,
    _byte_size, _width, _height, _checksum_sha256, _storage_bucket, _storage_path, 'private'
  );

  INSERT INTO public.bulk_photo_items (
    id, session_id, image_url, storage_path, sort_order, created_by, media_asset_id
  ) VALUES (
    item_id, session.id, 'private-media://' || _media_asset_id, _storage_path,
    _sort_order, _actor_id, _media_asset_id
  );

  INSERT INTO public.media_variants (
    id, photo_id, media_asset_id, variant_type, image_url, storage_bucket, storage_path,
    content_type, original_filename, processing_status, width, height, byte_size,
    checksum, variant_role, created_by
  ) VALUES (
    variant_id, NULL, _media_asset_id, 'original', 'private-media://' || variant_id,
    _storage_bucket, _storage_path, _content_type, left(_original_filename,255),
    'completed', _width, _height, _byte_size, _checksum_sha256, 'source', _actor_id
  );

  INSERT INTO private.background_jobs (
    job_type, payload, dealership_id, resource_type, resource_id, dedupe_key,
    max_attempts, priority, created_by
  ) VALUES (
    'media.thumbnail.generate', jsonb_build_object('media_asset_id', _media_asset_id),
    store.id, 'media_asset', _media_asset_id, 'thumbnail:' || _media_asset_id,
    4, 20, _actor_id
  ) ON CONFLICT (job_type, dedupe_key) DO NOTHING;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('vehicle_media.original_finalized', _actor_id, store.id,
          jsonb_build_object('capture_session_id', session.id, 'bulk_item_id', item_id,
                             'media_asset_id', _media_asset_id));
  RETURN jsonb_build_object('bulk_item_id', item_id, 'media_asset_id', _media_asset_id);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_private_bulk_upload(
  uuid, uuid, uuid, text, text, text, text, bigint, integer, integer, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_private_bulk_upload(
  uuid, uuid, uuid, text, text, text, text, bigint, integer, integer, text, integer
) TO service_role;

CREATE OR REPLACE FUNCTION public.commit_private_photo_variant(
  _actor_id uuid,
  _photo_id uuid,
  _variant_id uuid,
  _variant_type text,
  _source_variant_id uuid,
  _storage_bucket text,
  _storage_path text,
  _content_type text,
  _byte_size bigint,
  _width integer,
  _height integer,
  _checksum_sha256 text,
  _processing_provider text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  photo public.photos%ROWTYPE;
  asset public.media_assets%ROWTYPE;
BEGIN
  IF _variant_type NOT IN ('cutout','corrected_cutout','customized','enhanced','dealer_render') THEN
    RAISE EXCEPTION 'Unsupported media variant type.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO photo FROM public.photos WHERE id = _photo_id FOR UPDATE;
  SELECT * INTO asset FROM public.media_assets WHERE id = photo.media_asset_id;
  IF photo.id IS NULL OR asset.id IS NULL THEN RAISE EXCEPTION 'Photo not found.' USING ERRCODE = 'P0002'; END IF;
  IF NOT (
    private.actor_is_active_owner(_actor_id)
    OR private.actor_is_active_dealer_admin_for(_actor_id, asset.dealership_id)
    OR EXISTS (
      SELECT 1 FROM public.profile_dealerships pd
      JOIN public.profiles p ON p.id = pd.profile_id
      JOIN public.user_onboarding uo ON uo.profile_id = p.id
      WHERE pd.profile_id = _actor_id AND pd.dealership_id = asset.dealership_id
        AND pd.access_role IN ('store_manager','inventory_media')
        AND p.status='active' AND uo.onboarding_state='complete'
        AND uo.password_change_required=false
    )
  ) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  IF _storage_bucket <> 'dealer-media-private'
     OR _storage_path NOT LIKE 'stores/' || asset.dealership_id || '/vehicles/' || asset.vehicle_id || '/media/' || asset.id || '/variants/%'
     OR _content_type NOT IN ('image/jpeg','image/png','image/webp')
     OR _byte_size NOT BETWEEN 1 AND 26214400
     OR _checksum_sha256 !~ '^[0-9a-f]{64}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.media_variants mv
       WHERE mv.id = _source_variant_id AND mv.media_asset_id = asset.id AND mv.archived_at IS NULL
     ) THEN RAISE EXCEPTION 'Invalid private variant finalization.' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.media_variants (
    id, photo_id, media_asset_id, variant_type, source_variant_id, image_url,
    storage_bucket, storage_path, content_type, processing_provider,
    processing_status, width, height, byte_size, checksum, variant_role, created_by
  ) VALUES (
    _variant_id, photo.id, asset.id, _variant_type, _source_variant_id,
    'private-media://' || _variant_id, _storage_bucket, _storage_path, _content_type,
    _processing_provider, 'completed', _width, _height, _byte_size,
    _checksum_sha256, 'prepared', _actor_id
  );

  UPDATE public.photos
  SET image_url = 'private-media://' || _variant_id,
      approved_variant_id = _variant_id,
      cutout_image_url = CASE WHEN _variant_type IN ('cutout','corrected_cutout')
        THEN 'private-media://' || _variant_id ELSE cutout_image_url END,
      corrected_cutout_url = CASE WHEN _variant_type='corrected_cutout'
        THEN 'private-media://' || _variant_id ELSE corrected_cutout_url END,
      is_cutout = CASE WHEN _variant_type IN ('cutout','corrected_cutout') THEN true ELSE is_cutout END,
      cutout_status = CASE WHEN _variant_type IN ('cutout','corrected_cutout') THEN 'done' ELSE cutout_status END,
      photo_state = CASE WHEN _variant_type IN ('cutout','corrected_cutout') THEN 'cutout' ELSE 'customized' END,
      processing_status='completed', processing_error=NULL, review_status='awaiting_review', updated_at=now()
  WHERE id = photo.id;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('vehicle_media.variant_created', _actor_id, asset.dealership_id,
          jsonb_build_object('vehicle_id', asset.vehicle_id, 'photo_id', photo.id,
                             'media_asset_id', asset.id, 'variant_id', _variant_id,
                             'variant_type', _variant_type));
  RETURN jsonb_build_object('variant_id', _variant_id, 'media_asset_id', asset.id);
END;
$$;

REVOKE ALL ON FUNCTION public.commit_private_photo_variant(
  uuid, uuid, uuid, text, uuid, text, text, text, bigint, integer, integer, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_private_photo_variant(
  uuid, uuid, uuid, text, uuid, text, text, text, bigint, integer, integer, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.archive_private_media_asset(
  _actor_id uuid,
  _media_asset_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  asset public.media_assets%ROWTYPE;
  photo_id uuid;
BEGIN
  SELECT * INTO asset FROM public.media_assets WHERE id=_media_asset_id FOR UPDATE;
  IF asset.id IS NULL THEN RETURN false; END IF;
  IF NOT (
    private.actor_is_active_owner(_actor_id)
    OR private.actor_is_active_dealer_admin_for(_actor_id,asset.dealership_id)
    OR EXISTS (
      SELECT 1 FROM public.profile_dealerships pd
      JOIN public.profiles p ON p.id=pd.profile_id
      JOIN public.user_onboarding uo ON uo.profile_id=p.id
      WHERE pd.profile_id=_actor_id AND pd.dealership_id=asset.dealership_id
        AND pd.access_role IN ('store_manager','inventory_media')
        AND p.status='active' AND uo.onboarding_state='complete'
        AND uo.password_change_required=false
    )
  ) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  SELECT id INTO photo_id FROM public.photos WHERE media_asset_id=asset.id LIMIT 1;
  UPDATE public.media_assets SET lifecycle_state='archived',archived_at=now(),updated_at=now()
  WHERE id=asset.id;
  UPDATE public.media_variants SET archived_at=now() WHERE media_asset_id=asset.id AND archived_at IS NULL;
  DELETE FROM public.bulk_photo_items WHERE media_asset_id=asset.id;
  DELETE FROM public.photos WHERE media_asset_id=asset.id;
  INSERT INTO public.audit_events (event_type,actor_profile_id,dealership_id,payload)
  VALUES ('vehicle_media.archived',_actor_id,asset.dealership_id,
    jsonb_build_object('media_asset_id',asset.id,'vehicle_id',asset.vehicle_id,'photo_id',photo_id));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_private_media_asset(uuid,uuid)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.archive_private_media_asset(uuid,uuid) TO service_role;

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
  SELECT * INTO target FROM public.photo_capture_sessions
  WHERE id = _session_id AND mode = 'bulk' FOR UPDATE;
  SELECT dealership_id INTO target_dealership_id FROM public.vehicles WHERE id = _vehicle_id;
  IF target.id IS NULL OR target.status <> 'completed'
    OR target_dealership_id IS DISTINCT FROM target.dealership_id
    OR NOT private.current_user_is_dealership_admin(target.dealership_id)
  THEN RAISE EXCEPTION 'Bulk photo package cannot be associated.' USING ERRCODE = '42501'; END IF;

  UPDATE public.photo_capture_sessions SET vehicle_id=_vehicle_id, updated_at=now()
  WHERE id=target.id;
  UPDATE public.media_assets SET vehicle_id=_vehicle_id, updated_at=now()
  WHERE capture_session_id=target.id AND vehicle_id IS NULL;

  INSERT INTO public.photos (
    vehicle_id, image_url, original_image_url, shot_type, sort_order, is_main,
    capture_session_id, photo_state, media_asset_id, media_category
  )
  SELECT _vehicle_id, item.image_url, item.image_url, item.shot_type, item.sort_order,
    item.is_main AND NOT EXISTS (
      SELECT 1 FROM public.photos existing WHERE existing.vehicle_id=_vehicle_id AND existing.is_main
    ), target.id, 'raw', item.media_asset_id, private.classify_media_category(item.shot_type)
  FROM public.bulk_photo_items item
  WHERE item.session_id=target.id AND item.photo_id IS NULL
  ORDER BY item.sort_order, item.created_at;

  UPDATE public.bulk_photo_items item SET photo_id=photo.id
  FROM public.photos photo
  WHERE item.session_id=target.id AND item.photo_id IS NULL
    AND photo.capture_session_id=target.id AND photo.media_asset_id=item.media_asset_id;

  UPDATE public.media_variants mv
  SET storage_bucket=ma.storage_bucket, storage_path=ma.storage_object_path,
      content_type=ma.content_type, original_filename=ma.original_filename,
      width=ma.width, height=ma.height, byte_size=ma.byte_size,
      checksum=ma.checksum_sha256, variant_role='source',
      image_url='private-media://' || mv.id
  FROM public.photos p
  JOIN public.media_assets ma ON ma.id=p.media_asset_id
  WHERE mv.photo_id=p.id AND p.capture_session_id=target.id AND mv.variant_type='original';

  UPDATE public.photos p SET image_url='private-media://' || mv.id,
      original_image_url='private-media://' || mv.id, approved_variant_id=mv.id
  FROM public.media_variants mv
  WHERE mv.photo_id=p.id AND p.capture_session_id=target.id AND mv.variant_type='original';

  UPDATE public.photo_capture_sessions
  SET vehicle_id=_vehicle_id, status='prepared', prepared_by=actor_id,
      prepared_at=now(), updated_at=now()
  WHERE id=target.id RETURNING * INTO target;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES ('bulk_photo_session.associated', actor_id, target.dealership_id,
    jsonb_build_object('capture_session_id',target.id,'vehicle_id',_vehicle_id));
  RETURN target;
END;
$$;

REVOKE ALL ON FUNCTION public.associate_bulk_photo_session(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.associate_bulk_photo_session(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.worker_get_media_migration(_migration_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'migration_id', msm.id, 'media_asset_id', msm.media_asset_id,
    'media_variant_id', msm.media_variant_id, 'source_bucket', msm.source_bucket,
    'source_path', msm.source_path, 'destination_bucket', msm.destination_bucket,
    'destination_path', msm.destination_path, 'state', msm.state,
    'variant_type', mv.variant_type, 'dealership_id', ma.dealership_id,
    'vehicle_id', ma.vehicle_id
  )
  FROM private.media_storage_migrations msm
  JOIN public.media_variants mv ON mv.id=msm.media_variant_id
  JOIN public.media_assets ma ON ma.id=msm.media_asset_id
  WHERE msm.id=_migration_id;
$$;

CREATE OR REPLACE FUNCTION public.worker_complete_media_migration(
  _migration_id uuid,
  _checksum_sha256 text,
  _byte_size bigint,
  _content_type text,
  _width integer,
  _height integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  record private.media_storage_migrations%ROWTYPE;
  variant public.media_variants%ROWTYPE;
  asset public.media_assets%ROWTYPE;
BEGIN
  SELECT * INTO record FROM private.media_storage_migrations WHERE id=_migration_id FOR UPDATE;
  IF record.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO variant FROM public.media_variants WHERE id=record.media_variant_id;
  SELECT * INTO asset FROM public.media_assets WHERE id=record.media_asset_id;
  IF _checksum_sha256 !~ '^[0-9a-f]{64}$' OR _byte_size < 1
    OR _content_type NOT IN ('image/jpeg','image/png','image/webp')
  THEN RAISE EXCEPTION 'Invalid migration verification.' USING ERRCODE='22023'; END IF;

  UPDATE private.media_storage_migrations
  SET state='private', source_byte_size=_byte_size, destination_byte_size=_byte_size,
      source_checksum_sha256=_checksum_sha256,
      destination_checksum_sha256=_checksum_sha256, verified_at=now(),
      safe_error_code=NULL, updated_at=now()
  WHERE id=record.id;
  UPDATE public.media_variants
  SET storage_bucket=record.destination_bucket, storage_path=record.destination_path,
      image_url='private-media://' || id, content_type=_content_type,
      byte_size=_byte_size, width=_width, height=_height, checksum=_checksum_sha256,
      original_filename=COALESCE(original_filename,regexp_replace(record.source_path,'^.*/','')),
      variant_role=COALESCE(variant_role,CASE WHEN variant_type='original' THEN 'source' ELSE 'prepared' END)
  WHERE id=variant.id;
  IF variant.variant_type='original' THEN
    UPDATE public.media_assets
    SET storage_bucket=record.destination_bucket, storage_object_path=record.destination_path,
        content_type=_content_type, byte_size=_byte_size, width=_width, height=_height,
        checksum_sha256=_checksum_sha256, migration_state='private', updated_at=now()
    WHERE id=asset.id;
    UPDATE public.photos p
    SET original_image_url='private-media://' || variant.id,
        image_url=CASE WHEN p.approved_variant_id=variant.id THEN 'private-media://' || variant.id ELSE p.image_url END,
        updated_at=now()
    WHERE p.media_asset_id=asset.id;
    INSERT INTO private.background_jobs (
      job_type,payload,dealership_id,resource_type,resource_id,dedupe_key,
      max_attempts,priority,created_by
    ) VALUES (
      'media.thumbnail.generate',jsonb_build_object('media_asset_id',asset.id),
      asset.dealership_id,'media_asset',asset.id,'thumbnail:'||asset.id,4,20,asset.uploaded_by
    ) ON CONFLICT (job_type,dedupe_key) DO NOTHING;
  ELSE
    UPDATE public.photos p
    SET image_url=CASE WHEN p.approved_variant_id=variant.id THEN 'private-media://' || variant.id ELSE p.image_url END,
        cutout_image_url=CASE WHEN p.cutout_image_url=variant.image_url THEN 'private-media://' || variant.id ELSE p.cutout_image_url END,
        corrected_cutout_url=CASE WHEN p.corrected_cutout_url=variant.image_url THEN 'private-media://' || variant.id ELSE p.corrected_cutout_url END,
        updated_at=now()
    WHERE p.media_asset_id=asset.id;
  END IF;
  INSERT INTO public.audit_events (event_type,dealership_id,payload)
  VALUES ('vehicle_media.migration_completed',asset.dealership_id,
    jsonb_build_object('media_asset_id',asset.id,'media_variant_id',variant.id));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_fail_media_migration(
  _migration_id uuid,
  _safe_error_code text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE private.media_storage_migrations
  SET state='failed',attempt_count=attempt_count+1,
      safe_error_code=left(COALESCE(_safe_error_code,'unknown_error'),120),updated_at=now()
  WHERE id=_migration_id RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.worker_get_media_asset_source(_media_asset_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'media_asset_id',ma.id,'dealership_id',ma.dealership_id,'vehicle_id',ma.vehicle_id,
    'bucket',mv.storage_bucket,'path',mv.storage_path,'photo_id',mv.photo_id,
    'source_variant_id',mv.id,'content_type',mv.content_type
  )
  FROM public.media_assets ma
  JOIN public.media_variants mv ON mv.media_asset_id=ma.id AND mv.variant_type='original'
  WHERE ma.id=_media_asset_id AND ma.lifecycle_state<>'archived'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.worker_get_media_migration_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'total',count(*),
    'private',count(*) FILTER (WHERE state='private'),
    'failed',count(*) FILTER (WHERE state='failed'),
    'pending',count(*) FILTER (WHERE state IN ('legacy','copying')),
    'unresolved_orphans',(SELECT count(*) FROM private.media_orphan_audit WHERE resolution='unresolved')
  )
  FROM private.media_storage_migrations;
$$;

CREATE OR REPLACE FUNCTION public.worker_register_media_derivative(
  _media_asset_id uuid,
  _variant_type text,
  _variant_role text,
  _storage_bucket text,
  _storage_path text,
  _content_type text,
  _byte_size bigint,
  _width integer,
  _height integer,
  _checksum_sha256 text,
  _processing_provider text,
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source public.media_variants%ROWTYPE;
  result_id uuid;
  new_variant_id uuid := gen_random_uuid();
BEGIN
  IF _variant_type NOT IN ('thumbnail','preview') OR _variant_role NOT IN ('thumbnail_small','preview')
    OR _storage_bucket <> 'dealer-media-private' OR _checksum_sha256 !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(_metadata)<>'object'
  THEN RAISE EXCEPTION 'Invalid derivative.' USING ERRCODE='22023'; END IF;
  SELECT * INTO source FROM public.media_variants
  WHERE media_asset_id=_media_asset_id AND variant_type='original' LIMIT 1;
  IF source.id IS NULL THEN RAISE EXCEPTION 'Original media is unavailable.' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.media_variants (
    id,photo_id,media_asset_id,variant_type,source_variant_id,image_url,storage_bucket,
    storage_path,content_type,processing_provider,processing_status,width,height,
    byte_size,checksum,variant_role,metadata
  ) VALUES (
    new_variant_id,source.photo_id,_media_asset_id,_variant_type,source.id,'private-media://'||new_variant_id,
    _storage_bucket,_storage_path,_content_type,_processing_provider,'completed',_width,_height,
    _byte_size,_checksum_sha256,_variant_role,_metadata
  )
  ON CONFLICT (storage_bucket,storage_path) WHERE storage_bucket IS NOT NULL AND storage_path IS NOT NULL
  DO UPDATE SET processing_status='completed',width=EXCLUDED.width,height=EXCLUDED.height,
    byte_size=EXCLUDED.byte_size,checksum=EXCLUDED.checksum,metadata=EXCLUDED.metadata
  RETURNING id INTO result_id;
  RETURN result_id;
END;
$$;

REVOKE ALL ON FUNCTION public.worker_get_media_migration(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.worker_complete_media_migration(uuid,text,bigint,text,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.worker_fail_media_migration(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.worker_get_media_asset_source(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.worker_get_media_migration_status() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.worker_register_media_derivative(uuid,text,text,text,text,text,bigint,integer,integer,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.worker_get_media_migration(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_complete_media_migration(uuid,text,bigint,text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_fail_media_migration(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_get_media_asset_source(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_get_media_migration_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_register_media_derivative(uuid,text,text,text,text,text,bigint,integer,integer,text,text,jsonb) TO service_role;

-- All client creation of physical originals/variants now goes through trusted
-- server functions. Existing row-level reads remain available for app state.
REVOKE INSERT, DELETE ON public.photos, public.bulk_photo_items FROM authenticated;
REVOKE ALL ON FUNCTION public.commit_photo_variant(uuid,text,text,text,text)
FROM authenticated, anon, PUBLIC;

DROP POLICY IF EXISTS "Active members insert vehicle photos" ON storage.objects;
DROP POLICY IF EXISTS "Active members update vehicle photos" ON storage.objects;
DROP POLICY IF EXISTS "Active members delete vehicle photos" ON storage.objects;
DROP POLICY IF EXISTS "Public read vehicle photos" ON storage.objects;

DROP POLICY IF EXISTS "Authorized users read private media" ON storage.objects;
CREATE POLICY "Authorized users read private media"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'dealer-media-private'
  AND EXISTS (
    SELECT 1
    FROM public.media_variants mv
    WHERE mv.storage_bucket = storage.objects.bucket_id
      AND mv.storage_path = storage.objects.name
      AND private.current_user_can_access_media_asset(mv.media_asset_id, 'preview')
  )
);

-- No INSERT/UPDATE/DELETE policy is granted for the private bucket. The web
-- server creates a path-scoped upload token and trusted services finalize it.

-- Explicit privileges for evolved tables. Newer hosted projects do not infer
-- Data API privileges from RLS alone.
REVOKE ALL ON public.media_assets, public.media_variants FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.media_assets, public.media_variants TO authenticated;
GRANT ALL ON public.media_assets, public.media_variants TO service_role;

COMMENT ON TABLE public.media_assets IS
  'Tenant-scoped immutable source ledger; delivery URLs are issued dynamically and are never authoritative.';
COMMENT ON COLUMN public.photos.image_url IS
  'Legacy compatibility locator. New private media uses private-media:// references; resolve through media_asset_id.';
