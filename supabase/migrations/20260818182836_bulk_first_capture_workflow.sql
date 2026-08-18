-- Make high-throughput Bulk Capture the store-configurable default while
-- retaining Guided Capture as an optional mode. Capture workflow transitions
-- remain database-authorized and resumable.

ALTER TABLE public.photography_settings
  ADD COLUMN bulk_capture_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN guided_capture_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN default_capture_method text NOT NULL DEFAULT 'bulk'
    CHECK (default_capture_method IN ('bulk','guided')),
  ADD CONSTRAINT photography_settings_capture_method_enabled_check CHECK (
    (bulk_capture_enabled OR guided_capture_enabled)
    AND (default_capture_method <> 'bulk' OR bulk_capture_enabled)
    AND (default_capture_method <> 'guided' OR guided_capture_enabled)
  );

ALTER TABLE public.photo_capture_sessions
  ADD COLUMN capture_ended_at timestamptz,
  ADD COLUMN workflow_stage text NOT NULL DEFAULT 'capture'
    CHECK (workflow_stage IN ('capture','review','processing','completed')),
  ADD COLUMN retake_count integer NOT NULL DEFAULT 0 CHECK (retake_count >= 0),
  ADD CONSTRAINT photo_capture_sessions_capture_ended_after_start_check
    CHECK (capture_ended_at IS NULL OR capture_ended_at >= started_at);

UPDATE public.photo_capture_sessions
SET capture_ended_at = completed_at,
    workflow_stage = CASE
      WHEN status = 'prepared' THEN 'completed'
      WHEN status = 'completed' THEN 'processing'
      ELSE 'capture'
    END
WHERE completed_at IS NOT NULL;

CREATE INDEX photo_capture_sessions_store_mode_stage_idx
  ON public.photo_capture_sessions (dealership_id, mode, workflow_stage, created_at DESC);

CREATE OR REPLACE FUNCTION private.capture_method_enabled(
  _dealership_id uuid,
  _mode text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE _mode
    WHEN 'bulk' THEN coalesce(settings.bulk_capture_enabled, true)
    WHEN 'guided' THEN coalesce(settings.guided_capture_enabled, true)
    ELSE false
  END
  FROM (SELECT 1) AS seed
  LEFT JOIN public.photography_settings AS settings
    ON settings.dealership_id = _dealership_id;
$$;

REVOKE ALL ON FUNCTION private.capture_method_enabled(uuid,text)
FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_capture_method_configuration(_dealership_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  settings public.photography_settings%ROWTYPE;
BEGIN
  IF NOT private.current_user_has_active_membership(_dealership_id) THEN
    RAISE EXCEPTION 'Capture settings are unavailable.' USING ERRCODE='42501';
  END IF;
  SELECT * INTO settings FROM public.photography_settings
  WHERE dealership_id = _dealership_id;
  RETURN jsonb_build_object(
    'bulk_enabled', coalesce(settings.bulk_capture_enabled, true),
    'guided_enabled', coalesce(settings.guided_capture_enabled, true),
    'default_method', coalesce(settings.default_capture_method, 'bulk')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_capture_method_configuration(
  _dealership_id uuid,
  _bulk_enabled boolean,
  _guided_enabled boolean,
  _default_method text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE actor_id uuid := (SELECT auth.uid());
BEGIN
  IF NOT private.current_user_has_store_capability(_dealership_id,'settings') THEN
    RAISE EXCEPTION 'Capture settings are unavailable.' USING ERRCODE='42501';
  END IF;
  IF NOT coalesce(_bulk_enabled,false) AND NOT coalesce(_guided_enabled,false) THEN
    RAISE EXCEPTION 'At least one capture method must remain enabled.' USING ERRCODE='22023';
  END IF;
  IF _default_method NOT IN ('bulk','guided')
     OR (_default_method='bulk' AND NOT _bulk_enabled)
     OR (_default_method='guided' AND NOT _guided_enabled) THEN
    RAISE EXCEPTION 'The default capture method must be enabled.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.photography_settings (
    dealership_id,completion_policy,bulk_capture_enabled,guided_capture_enabled,
    default_capture_method,updated_by,updated_at
  ) VALUES (
    _dealership_id,'warn',_bulk_enabled,_guided_enabled,_default_method,actor_id,now()
  )
  ON CONFLICT (dealership_id) DO UPDATE SET
    bulk_capture_enabled=EXCLUDED.bulk_capture_enabled,
    guided_capture_enabled=EXCLUDED.guided_capture_enabled,
    default_capture_method=EXCLUDED.default_capture_method,
    updated_by=EXCLUDED.updated_by,updated_at=now();
  INSERT INTO public.audit_events (event_type,actor_profile_id,dealership_id,payload)
  VALUES ('configuration.capture_methods_changed',actor_id,_dealership_id,
    jsonb_build_object('bulk_enabled',_bulk_enabled,'guided_enabled',_guided_enabled,
      'default_method',_default_method));
  RETURN public.get_capture_method_configuration(_dealership_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_capture_method_configuration(uuid)
FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.save_capture_method_configuration(uuid,boolean,boolean,text)
FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_capture_method_configuration(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_capture_method_configuration(uuid,boolean,boolean,text)
TO authenticated;

-- Session creation is an authorized operation, not a raw table insert.
REVOKE INSERT ON public.photo_capture_sessions FROM authenticated;

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
  END IF;
  IF target.id IS NULL THEN
    RAISE EXCEPTION 'Capture session could not be started.' USING ERRCODE='23505';
  END IF;
  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_bulk_capture_ended(_session_id uuid)
RETURNS public.photo_capture_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE target public.photo_capture_sessions;
BEGIN
  SELECT * INTO target FROM public.photo_capture_sessions
  WHERE id=_session_id FOR UPDATE;
  IF target.id IS NULL OR target.mode<>'bulk' OR target.status<>'in_progress'
     OR NOT private.current_user_can_mutate_capture_session(target.id)
     OR NOT (
       private.current_user_has_store_capability(target.dealership_id,'capture')
       OR private.current_user_has_store_capability(target.dealership_id,'media')
     ) THEN
    RAISE EXCEPTION 'Bulk Capture is unavailable.' USING ERRCODE='42501';
  END IF;
  UPDATE public.photo_capture_sessions
  SET capture_ended_at=coalesce(capture_ended_at,now()),workflow_stage='review',updated_at=now()
  WHERE id=target.id RETURNING * INTO target;
  RETURN target;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_bulk_capture_ended(uuid)
FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mark_bulk_capture_ended(uuid) TO authenticated;

-- Completion keeps the existing payout/activity semantics, but capture duration
-- stops when the photographer intentionally ends shooting, not after uploads.
CREATE OR REPLACE FUNCTION public.complete_photo_capture_session(_session_id uuid)
RETURNS public.photo_capture_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.photo_capture_sessions;
  event public.activity_events;
BEGIN
  SELECT * INTO target FROM public.photo_capture_sessions WHERE id=_session_id FOR UPDATE;
  IF target.id IS NULL OR NOT private.current_user_can_mutate_capture_session(target.id) THEN
    RAISE EXCEPTION 'Capture session is unavailable.' USING ERRCODE='42501';
  END IF;
  IF target.status IN ('completed','prepared') THEN RETURN target; END IF;
  IF target.mode='bulk' THEN
    SELECT count(*),0,
      count(*) FILTER (WHERE lower(coalesce(shot_type,'')) IN
        ('front','rear','driver side','passenger side','front 3/4','rear 3/4','wheel','engine bay')),
      count(*) FILTER (WHERE lower(coalesce(shot_type,'')) LIKE '%interior%'),
      count(*) FILTER (WHERE lower(coalesce(shot_type,'')) NOT IN
        ('front','rear','driver side','passenger side','front 3/4','rear 3/4','wheel','engine bay')
        AND lower(coalesce(shot_type,'')) NOT LIKE '%interior%')
    INTO target.photo_count,target.video_count,target.exterior_count,target.interior_count,target.detail_count
    FROM public.bulk_photo_items WHERE session_id=target.id;
  ELSE
    SELECT count(*) FILTER (WHERE media_kind='photo'),count(*) FILTER (WHERE media_kind='video'),
      count(*) FILTER (WHERE media_category='exterior'),
      count(*) FILTER (WHERE media_category='interior'),
      count(*) FILTER (WHERE media_category='detail')
    INTO target.photo_count,target.video_count,target.exterior_count,target.interior_count,target.detail_count
    FROM public.photos WHERE capture_session_id=target.id;
  END IF;
  IF target.photo_count + target.video_count < 1 THEN
    RAISE EXCEPTION 'Capture at least one media item before completing this session.' USING ERRCODE='23514';
  END IF;
  UPDATE public.photo_capture_sessions SET
    status='completed',completed_by=actor_id,completed_at=now(),
    capture_ended_at=coalesce(capture_ended_at,now()),workflow_stage='processing',
    duration_seconds=greatest(0,extract(epoch FROM (coalesce(capture_ended_at,now())-started_at))::integer),
    photo_count=target.photo_count,video_count=target.video_count,
    exterior_count=target.exterior_count,interior_count=target.interior_count,
    detail_count=target.detail_count,review_status='awaiting_review',updated_at=now()
  WHERE id=target.id RETURNING * INTO target;
  SELECT * INTO event FROM private.record_activity(
    target.dealership_id,target.vehicle_id,target.id,actor_id,
    CASE target.mode WHEN 'bulk' THEN 'bulk_photo_session.completed' ELSE 'photo_shoot.completed' END,
    CASE target.mode WHEN 'bulk' THEN 'Bulk vehicle capture completed' ELSE 'Vehicle photo shoot completed' END,
    jsonb_build_object('photo_count',target.photo_count,'video_count',target.video_count,
      'duration_seconds',target.duration_seconds,'shoot_type',target.shoot_type,
      'capture_method',target.mode,'retake_count',target.retake_count)
  );
  PERFORM private.create_shoot_payout(target,event.id);
  INSERT INTO public.audit_events (event_type,actor_profile_id,dealership_id,payload)
  VALUES (CASE target.mode WHEN 'bulk' THEN 'bulk_photo_session.completed' ELSE 'photo_session.completed' END,
    actor_id,target.dealership_id,jsonb_build_object('capture_session_id',target.id,
      'vehicle_id',target.vehicle_id,'photo_count',target.photo_count,
      'duration_seconds',target.duration_seconds,'capture_method',target.mode));
  IF target.vehicle_id IS NOT NULL THEN PERFORM private.evaluate_vehicle_readiness(target.vehicle_id); END IF;
  RETURN target;
END;
$$;

-- An own Bulk session can be prepared by a capture user. Media-capable users
-- may prepare any authorized store session. A pre-bound vehicle cannot be
-- silently swapped to another vehicle.
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
  WHERE id=_session_id AND mode='bulk' FOR UPDATE;
  SELECT dealership_id INTO target_dealership_id FROM public.vehicles WHERE id=_vehicle_id;
  IF target.id IS NULL OR target.status<>'completed'
     OR target_dealership_id IS DISTINCT FROM target.dealership_id
     OR (target.vehicle_id IS NOT NULL AND target.vehicle_id<>_vehicle_id)
     OR NOT (
       private.current_user_has_store_capability(target.dealership_id,'media')
       OR (target.created_by=actor_id
           AND private.current_user_has_store_capability(target.dealership_id,'capture'))
     ) THEN
    RAISE EXCEPTION 'Bulk photo package cannot be associated.' USING ERRCODE='42501';
  END IF;
  UPDATE public.photo_capture_sessions SET vehicle_id=_vehicle_id,updated_at=now()
  WHERE id=target.id;
  UPDATE public.media_assets SET vehicle_id=_vehicle_id,updated_at=now()
  WHERE capture_session_id=target.id AND vehicle_id IS NULL;
  INSERT INTO public.photos (
    vehicle_id,image_url,original_image_url,shot_type,sort_order,is_main,
    capture_session_id,photo_state,media_asset_id,media_category
  )
  SELECT _vehicle_id,item.image_url,item.image_url,item.shot_type,item.sort_order,
    item.is_main AND NOT EXISTS (SELECT 1 FROM public.photos p WHERE p.vehicle_id=_vehicle_id AND p.is_main),
    target.id,'raw',item.media_asset_id,private.classify_media_category(item.shot_type)
  FROM public.bulk_photo_items AS item
  WHERE item.session_id=target.id AND item.photo_id IS NULL
  ORDER BY item.sort_order,item.created_at;
  UPDATE public.bulk_photo_items AS item SET photo_id=photo.id
  FROM public.photos AS photo
  WHERE item.session_id=target.id AND item.photo_id IS NULL
    AND photo.capture_session_id=target.id AND photo.media_asset_id=item.media_asset_id;
  UPDATE public.media_variants AS mv SET
    storage_bucket=ma.storage_bucket,storage_path=ma.storage_object_path,
    content_type=ma.content_type,original_filename=ma.original_filename,
    width=ma.width,height=ma.height,byte_size=ma.byte_size,checksum=ma.checksum_sha256,
    variant_role='source',image_url='private-media://'||mv.id
  FROM public.photos AS photo JOIN public.media_assets AS ma ON ma.id=photo.media_asset_id
  WHERE mv.photo_id=photo.id AND photo.capture_session_id=target.id AND mv.variant_type='original';
  UPDATE public.photos AS photo SET image_url='private-media://'||mv.id,
    original_image_url='private-media://'||mv.id,approved_variant_id=mv.id
  FROM public.media_variants AS mv
  WHERE mv.photo_id=photo.id AND photo.capture_session_id=target.id AND mv.variant_type='original';
  UPDATE public.photo_capture_sessions SET vehicle_id=_vehicle_id,status='prepared',
    prepared_by=actor_id,prepared_at=coalesce(prepared_at,now()),workflow_stage='processing',updated_at=now()
  WHERE id=target.id RETURNING * INTO target;
  INSERT INTO public.audit_events (event_type,actor_profile_id,dealership_id,payload)
  VALUES ('bulk_photo_session.associated',actor_id,target.dealership_id,
    jsonb_build_object('capture_session_id',target.id,'vehicle_id',_vehicle_id));
  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_bulk_background_removal(
  _session_id uuid,
  _item_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.photo_capture_sessions;
  item record;
  queued integer := 0;
BEGIN
  SELECT * INTO target FROM public.photo_capture_sessions
  WHERE id=_session_id AND mode='bulk' FOR UPDATE;
  IF target.id IS NULL OR target.status<>'prepared' OR target.vehicle_id IS NULL
     OR coalesce(cardinality(_item_ids),0)>100
     OR NOT (
       private.current_user_has_store_capability(target.dealership_id,'media')
       OR (target.created_by=actor_id
           AND private.current_user_has_store_capability(target.dealership_id,'capture'))
     ) THEN
    RAISE EXCEPTION 'Background processing selection is unavailable.' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(_item_ids),0)<>coalesce((SELECT count(DISTINCT id) FROM unnest(_item_ids) id),0) THEN
    RAISE EXCEPTION 'Background processing selection contains duplicates.' USING ERRCODE='22023';
  END IF;
  FOR item IN
    SELECT bulk.id,bulk.media_asset_id,bulk.photo_id
    FROM public.bulk_photo_items AS bulk
    WHERE bulk.session_id=target.id AND bulk.id=ANY(coalesce(_item_ids,ARRAY[]::uuid[]))
      AND bulk.photo_id IS NOT NULL AND bulk.media_asset_id IS NOT NULL
  LOOP
    INSERT INTO private.background_jobs (
      job_type,payload,dealership_id,resource_type,resource_id,dedupe_key,
      max_attempts,priority,created_by
    ) VALUES (
      'media.background.remove',
      jsonb_build_object('media_asset_id',item.media_asset_id,'photo_id',item.photo_id),
      target.dealership_id,'media_asset',item.media_asset_id,
      'background-remove:'||item.media_asset_id||':v1',3,30,actor_id
    ) ON CONFLICT (job_type,dedupe_key) DO NOTHING;
    IF FOUND THEN
      queued := queued+1;
      UPDATE public.photos SET processing_action='background_replace',processing_status='queued',
        processing_error=NULL,updated_at=now() WHERE id=item.photo_id;
    END IF;
  END LOOP;
  IF queued>0 THEN
    INSERT INTO public.audit_events (event_type,actor_profile_id,dealership_id,payload)
    VALUES ('bulk_photo.background_processing_queued',actor_id,target.dealership_id,
      jsonb_build_object('capture_session_id',target.id,'vehicle_id',target.vehicle_id,
        'selected_count',cardinality(_item_ids),'queued_count',queued));
  END IF;
  RETURN queued;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_bulk_capture_workflow(_session_id uuid)
RETURNS public.photo_capture_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE target public.photo_capture_sessions;
BEGIN
  SELECT * INTO target FROM public.photo_capture_sessions
  WHERE id=_session_id AND mode='bulk' FOR UPDATE;
  IF target.id IS NULL OR target.status<>'prepared'
     OR NOT (
       private.current_user_has_store_capability(target.dealership_id,'media')
       OR (target.created_by=(SELECT auth.uid())
           AND private.current_user_has_store_capability(target.dealership_id,'capture'))
     ) THEN
    RAISE EXCEPTION 'Bulk Capture workflow is unavailable.' USING ERRCODE='42501';
  END IF;
  UPDATE public.photo_capture_sessions SET workflow_stage='completed',updated_at=now()
  WHERE id=target.id RETURNING * INTO target;
  RETURN target;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_bulk_background_removal(uuid,uuid[])
FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.complete_bulk_capture_workflow(uuid)
FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.queue_bulk_background_removal(uuid,uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_bulk_capture_workflow(uuid) TO authenticated;

-- Worker-only accessors keep job payloads untrusted and derive the source and
-- output authorization from the durable queued job.
CREATE OR REPLACE FUNCTION public.worker_get_background_removal_source(_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'job_id',job.id,'actor_id',job.created_by,'media_asset_id',asset.id,
    'dealership_id',asset.dealership_id,'vehicle_id',asset.vehicle_id,
    'photo_id',photo.id,'source_variant_id',variant.id,
    'bucket',variant.storage_bucket,'path',variant.storage_path,
    'content_type',variant.content_type
  )
  FROM private.background_jobs AS job
  JOIN public.media_assets AS asset ON asset.id=job.resource_id
  JOIN public.photos AS photo ON photo.media_asset_id=asset.id
  JOIN public.media_variants AS variant ON variant.media_asset_id=asset.id
    AND variant.variant_type='original' AND variant.archived_at IS NULL
  WHERE job.id=_job_id AND job.job_type='media.background.remove'
    AND asset.lifecycle_state='active' AND asset.vehicle_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.worker_commit_background_cutout(
  _job_id uuid,
  _variant_id uuid,
  _storage_bucket text,
  _storage_path text,
  _byte_size bigint,
  _width integer,
  _height integer,
  _checksum_sha256 text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source jsonb;
  result_id uuid;
BEGIN
  source := public.worker_get_background_removal_source(_job_id);
  IF source IS NULL OR _storage_bucket<>'dealer-media-private'
     OR _storage_path NOT LIKE 'stores/'||(source->>'dealership_id')||'/vehicles/'||
       (source->>'vehicle_id')||'/media/'||(source->>'media_asset_id')||'/variants/cutout/%'
     OR _byte_size NOT BETWEEN 1 AND 26214400 OR _width<1 OR _height<1
     OR _checksum_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid background-removal output.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.media_variants (
    id,photo_id,media_asset_id,variant_type,source_variant_id,image_url,
    storage_bucket,storage_path,content_type,processing_provider,processing_status,
    width,height,byte_size,checksum,variant_role,created_by,metadata
  ) VALUES (
    _variant_id,(source->>'photo_id')::uuid,(source->>'media_asset_id')::uuid,'cutout',
    (source->>'source_variant_id')::uuid,'private-media://'||_variant_id,
    _storage_bucket,_storage_path,'image/png','dealershot-imgly-node','completed',
    _width,_height,_byte_size,_checksum_sha256,'prepared',(source->>'actor_id')::uuid,
    jsonb_build_object('operation','background_remove','job_id',_job_id)
  ) ON CONFLICT (storage_bucket,storage_path)
    WHERE storage_bucket IS NOT NULL AND storage_path IS NOT NULL
    DO UPDATE SET processing_status='completed',byte_size=EXCLUDED.byte_size,
      width=EXCLUDED.width,height=EXCLUDED.height,checksum=EXCLUDED.checksum
    RETURNING id INTO result_id;
  UPDATE public.photos SET image_url='private-media://'||result_id,
    approved_variant_id=result_id,cutout_image_url='private-media://'||result_id,
    is_cutout=true,cutout_status='done',photo_state='cutout',
    processing_action='background_replace',processing_status='completed',
    processing_provider='dealershot-imgly-node',processing_error=NULL,
    review_status='awaiting_review',updated_at=now()
  WHERE id=(source->>'photo_id')::uuid;
  INSERT INTO public.audit_events (event_type,actor_profile_id,dealership_id,payload)
  VALUES ('vehicle_media.variant_created',(source->>'actor_id')::uuid,
    (source->>'dealership_id')::uuid,jsonb_build_object(
      'vehicle_id',(source->>'vehicle_id')::uuid,'photo_id',(source->>'photo_id')::uuid,
      'media_asset_id',(source->>'media_asset_id')::uuid,'variant_id',result_id,
      'variant_type','cutout','job_id',_job_id));
  RETURN result_id;
END;
$$;

REVOKE ALL ON FUNCTION public.worker_get_background_removal_source(uuid)
FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.worker_commit_background_cutout(uuid,uuid,text,text,bigint,integer,integer,text)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.worker_get_background_removal_source(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_commit_background_cutout(uuid,uuid,text,text,bigint,integer,integer,text)
TO service_role;
