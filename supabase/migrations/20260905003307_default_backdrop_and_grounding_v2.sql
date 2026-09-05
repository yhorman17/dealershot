-- Store-owned default backdrops and atomic Original -> Cutout -> Prepared
-- lineage for successful automatic background removal.

ALTER TABLE public.backdrops
  ADD COLUMN IF NOT EXISTS storage_bucket text,
  ADD COLUMN IF NOT EXISTS storage_path text;

UPDATE public.backdrops
SET storage_bucket = 'backdrops',
    storage_path = substring(image_url FROM '/backdrops/(.+)$')
WHERE storage_bucket IS NULL
  AND storage_path IS NULL
  AND image_url LIKE '%/backdrops/%';

ALTER TABLE public.backdrops
  ADD CONSTRAINT backdrops_storage_identity_check CHECK (
    (storage_bucket IS NULL AND storage_path IS NULL)
    OR (
      storage_bucket = 'backdrops'
      AND storage_path IS NOT NULL
      AND storage_path !~ '(^|/)\.\.(/|$)'
      AND storage_path NOT LIKE '/%'
    )
  );

ALTER TABLE public.photography_settings
  ADD COLUMN IF NOT EXISTS default_backdrop_id uuid
  REFERENCES public.backdrops(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS photography_settings_default_backdrop_idx
  ON public.photography_settings(default_backdrop_id)
  WHERE default_backdrop_id IS NOT NULL;

DROP POLICY IF EXISTS "View backdrops in dealership" ON public.backdrops;
CREATE POLICY "View backdrops in authorized dealership"
ON public.backdrops FOR SELECT TO authenticated
USING (
  private.current_user_has_store_capability(dealership_id, 'media')
  OR private.current_user_has_store_capability(dealership_id, 'settings')
);

CREATE OR REPLACE FUNCTION public.save_default_processed_backdrop(
  _dealership_id uuid,
  _backdrop_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  selected_backdrop public.backdrops%ROWTYPE;
BEGIN
  IF actor_id IS NULL
     OR NOT private.current_user_has_store_capability(_dealership_id, 'settings') THEN
    RAISE EXCEPTION 'Default-backdrop settings are unavailable.' USING ERRCODE = '42501';
  END IF;

  IF _backdrop_id IS NOT NULL THEN
    SELECT * INTO selected_backdrop
    FROM public.backdrops
    WHERE id = _backdrop_id AND dealership_id = _dealership_id;

    IF selected_backdrop.id IS NULL
       OR selected_backdrop.storage_bucket IS DISTINCT FROM 'backdrops'
       OR selected_backdrop.storage_path IS NULL
       OR selected_backdrop.storage_path NOT LIKE _dealership_id::text || '/%' THEN
      RAISE EXCEPTION 'The selected backdrop is unavailable for this store.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.photography_settings (
    dealership_id, default_backdrop_id, updated_by, updated_at
  ) VALUES (
    _dealership_id, _backdrop_id, actor_id, now()
  )
  ON CONFLICT (dealership_id) DO UPDATE
  SET default_backdrop_id = EXCLUDED.default_backdrop_id,
      updated_by = actor_id,
      updated_at = now();

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES (
    'store_settings.default_processed_backdrop_changed',
    actor_id,
    _dealership_id,
    jsonb_build_object('backdrop_id', _backdrop_id)
  );

  RETURN jsonb_build_object(
    'dealership_id', _dealership_id,
    'default_backdrop_id', _backdrop_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_default_processed_backdrop(uuid, uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_default_processed_backdrop(uuid, uuid)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.worker_get_background_removal_source(_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'job_id', job.id,
    'actor_id', job.created_by,
    'media_asset_id', asset.id,
    'dealership_id', asset.dealership_id,
    'vehicle_id', asset.vehicle_id,
    'photo_id', photo.id,
    'shot_type', photo.shot_type,
    'source_variant_id', variant.id,
    'bucket', variant.storage_bucket,
    'path', variant.storage_path,
    'content_type', variant.content_type,
    'default_backdrop_id', backdrop.id,
    'default_backdrop_bucket', backdrop.storage_bucket,
    'default_backdrop_path', backdrop.storage_path
  )
  FROM private.background_jobs AS job
  JOIN public.media_assets AS asset ON asset.id = job.resource_id
  JOIN public.photos AS photo ON photo.media_asset_id = asset.id
  JOIN public.media_variants AS variant ON variant.media_asset_id = asset.id
    AND variant.variant_type = 'original' AND variant.archived_at IS NULL
  LEFT JOIN public.photography_settings AS settings
    ON settings.dealership_id = asset.dealership_id
  LEFT JOIN public.backdrops AS backdrop
    ON backdrop.id = settings.default_backdrop_id
    AND backdrop.dealership_id = asset.dealership_id
    AND backdrop.storage_bucket = 'backdrops'
    AND backdrop.storage_path LIKE asset.dealership_id::text || '/%'
  WHERE job.id = _job_id
    AND job.job_type = 'media.background.remove'
    AND job.status = 'running'
    AND job.cancel_requested_at IS NULL
    AND asset.lifecycle_state = 'active'
    AND asset.vehicle_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.worker_commit_background_cutout_and_default_composition(
  _job_id uuid,
  _variant_id uuid,
  _storage_bucket text,
  _storage_path text,
  _byte_size bigint,
  _width integer,
  _height integer,
  _checksum_sha256 text,
  _quality_class text,
  _diagnostics jsonb,
  _prepared_variant_id uuid,
  _prepared_storage_bucket text,
  _prepared_storage_path text,
  _prepared_byte_size bigint,
  _prepared_width integer,
  _prepared_height integer,
  _prepared_checksum_sha256 text,
  _backdrop_id uuid,
  _composition_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source jsonb;
  cutout_id uuid;
BEGIN
  source := public.worker_get_background_removal_source(_job_id);
  IF source IS NULL
     OR _quality_class <> 'good'
     OR (source->>'default_backdrop_id')::uuid IS DISTINCT FROM _backdrop_id
     OR _prepared_storage_bucket <> 'dealer-media-private'
     OR _prepared_storage_path NOT LIKE 'stores/' || (source->>'dealership_id') ||
       '/vehicles/' || (source->>'vehicle_id') || '/media/' ||
       (source->>'media_asset_id') || '/variants/customized/%'
     OR _prepared_byte_size NOT BETWEEN 1 AND 26214400
     OR _prepared_width <> 1600
     OR _prepared_height <> 1200
     OR _prepared_checksum_sha256 !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(COALESCE(_composition_metadata, '{}'::jsonb)) <> 'object'
     OR octet_length(COALESCE(_composition_metadata, '{}'::jsonb)::text) > 32768 THEN
    RAISE EXCEPTION 'Invalid default processed-photo composition.' USING ERRCODE = '22023';
  END IF;

  cutout_id := public.worker_commit_background_cutout_result(
    _job_id,
    _variant_id,
    _storage_bucket,
    _storage_path,
    _byte_size,
    _width,
    _height,
    _checksum_sha256,
    _quality_class,
    _diagnostics
  );

  INSERT INTO public.media_variants (
    id, photo_id, media_asset_id, variant_type, source_variant_id, image_url,
    storage_bucket, storage_path, content_type, processing_provider,
    processing_status, width, height, byte_size, checksum, variant_role,
    created_by, metadata
  ) VALUES (
    _prepared_variant_id,
    (source->>'photo_id')::uuid,
    (source->>'media_asset_id')::uuid,
    'customized',
    cutout_id,
    'private-media://' || _prepared_variant_id,
    _prepared_storage_bucket,
    _prepared_storage_path,
    'image/jpeg',
    'dealershot-grounding-v2',
    'completed',
    _prepared_width,
    _prepared_height,
    _prepared_byte_size,
    _prepared_checksum_sha256,
    'prepared',
    (source->>'actor_id')::uuid,
    jsonb_build_object(
      'operation', 'default_backdrop_compose',
      'job_id', _job_id,
      'backdrop_resource_id', _backdrop_id,
      'composition_size', jsonb_build_object('width', 1600, 'height', 1200),
      'source_cutout_variant_id', cutout_id,
      'auto_promoted', true
    ) || COALESCE(_composition_metadata, '{}'::jsonb)
  );

  UPDATE public.photos
  SET image_url = 'private-media://' || _prepared_variant_id,
      approved_variant_id = _prepared_variant_id,
      photo_state = 'customized',
      processing_status = 'completed',
      processing_provider = 'dealershot-grounding-v2',
      processing_error = NULL,
      review_status = 'awaiting_review',
      updated_at = now()
  WHERE id = (source->>'photo_id')::uuid;

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES (
    'vehicle_media.default_backdrop_composed',
    (source->>'actor_id')::uuid,
    (source->>'dealership_id')::uuid,
    jsonb_build_object(
      'vehicle_id', (source->>'vehicle_id')::uuid,
      'photo_id', (source->>'photo_id')::uuid,
      'media_asset_id', (source->>'media_asset_id')::uuid,
      'cutout_variant_id', cutout_id,
      'prepared_variant_id', _prepared_variant_id,
      'backdrop_id', _backdrop_id,
      'job_id', _job_id
    )
  );

  RETURN jsonb_build_object(
    'cutout_variant_id', cutout_id,
    'prepared_variant_id', _prepared_variant_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.worker_commit_background_cutout_and_default_composition(
  uuid, uuid, text, text, bigint, integer, integer, text, text, jsonb,
  uuid, text, text, bigint, integer, integer, text, uuid, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_commit_background_cutout_and_default_composition(
  uuid, uuid, text, text, bigint, integer, integer, text, text, jsonb,
  uuid, text, text, bigint, integer, integer, text, uuid, jsonb
) TO service_role;

-- Persist the selected per-photo backdrop on manually-created prepared
-- derivatives without widening the public finalization surface.
CREATE OR REPLACE FUNCTION public.commit_private_photo_variant_with_metadata(
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
  _processing_provider text,
  _metadata jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result jsonb;
  backdrop_id uuid;
  media_store_id uuid;
BEGIN
  IF _variant_type <> 'customized'
     OR jsonb_typeof(COALESCE(_metadata, '{}'::jsonb)) <> 'object'
     OR octet_length(COALESCE(_metadata, '{}'::jsonb)::text) > 16384 THEN
    RAISE EXCEPTION 'Invalid customized variant metadata.' USING ERRCODE = '22023';
  END IF;

  SELECT asset.dealership_id INTO media_store_id
  FROM public.photos AS photo
  JOIN public.media_assets AS asset ON asset.id = photo.media_asset_id
  WHERE photo.id = _photo_id;

  IF _metadata ? 'backdrop_resource_id' THEN
    backdrop_id := (_metadata->>'backdrop_resource_id')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.backdrops
      WHERE id = backdrop_id AND dealership_id = media_store_id
    ) THEN
      RAISE EXCEPTION 'The selected backdrop is unavailable for this photo.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  result := public.commit_private_photo_variant(
    _actor_id, _photo_id, _variant_id, _variant_type, _source_variant_id,
    _storage_bucket, _storage_path, _content_type, _byte_size, _width, _height,
    _checksum_sha256, _processing_provider
  );

  UPDATE public.media_variants
  SET metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(_metadata, '{}'::jsonb)
  WHERE id = _variant_id;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_private_photo_variant_with_metadata(
  uuid, uuid, uuid, text, uuid, text, text, text, bigint, integer, integer, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_private_photo_variant_with_metadata(
  uuid, uuid, uuid, text, uuid, text, text, text, bigint, integer, integer, text, text, jsonb
) TO service_role;

-- The current authorized test store explicitly uses Show room 2. This is a
-- store-scoped preference, not a product default, and is only applied when the
-- store has no prior preference.
UPDATE public.photography_settings AS settings
SET default_backdrop_id = backdrop.id,
    updated_at = now()
FROM public.backdrops AS backdrop
WHERE settings.dealership_id = 'bacaab56-5196-482e-8e0a-d7044e6fe57f'::uuid
  AND settings.default_backdrop_id IS NULL
  AND backdrop.id = '51881c70-0dcb-4e05-8cd3-975d4ce935b1'::uuid
  AND backdrop.dealership_id = settings.dealership_id
  AND backdrop.name = 'Show room 2';

COMMENT ON COLUMN public.photography_settings.default_backdrop_id IS
  'Store-scoped backdrop resource used for future successful automatic prepared compositions; NULL preserves a transparent cutout.';
COMMENT ON FUNCTION public.save_default_processed_backdrop(uuid, uuid) IS
  'Capability-authorized store default backdrop selection; validates tenant ownership and stable Storage identity.';
COMMENT ON FUNCTION public.worker_commit_background_cutout_and_default_composition(
  uuid, uuid, text, text, bigint, integer, integer, text, text, jsonb,
  uuid, text, text, bigint, integer, integer, text, uuid, jsonb
) IS
  'Atomically appends clean cutout and 1600x1200 default-backdrop prepared derivatives, promoting only the prepared result.';
