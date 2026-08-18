-- Controlled, auditable vehicle deletion with durable private Storage cleanup.
-- The database transaction removes business rows and writes an exact outbox
-- manifest. The worker then deletes only those Storage objects, with retries.

CREATE TABLE private.vehicle_deletion_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL UNIQUE,
  dealership_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  vehicle_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(vehicle_snapshot) = 'object'
      AND octet_length(vehicle_snapshot::text) <= 65536),
  storage_manifest jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(storage_manifest) = 'array'
      AND octet_length(storage_manifest::text) <= 1048576),
  database_status text NOT NULL DEFAULT 'deleted'
    CHECK (database_status = 'deleted'),
  storage_status text NOT NULL DEFAULT 'queued'
    CHECK (storage_status IN ('queued','running','succeeded','failed')),
  storage_attempt_count integer NOT NULL DEFAULT 0 CHECK (storage_attempt_count >= 0),
  safe_error_code text CHECK (safe_error_code IS NULL OR length(safe_error_code) <= 120),
  requested_at timestamptz NOT NULL DEFAULT now(),
  storage_started_at timestamptz,
  storage_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vehicle_deletion_operations_store_date_idx
  ON private.vehicle_deletion_operations (dealership_id, requested_at DESC);
CREATE INDEX vehicle_deletion_operations_storage_queue_idx
  ON private.vehicle_deletion_operations (storage_status, requested_at)
  WHERE storage_status IN ('queued','running','failed');

REVOKE ALL ON private.vehicle_deletion_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.vehicle_deletion_operations TO service_role;

-- Preserve vehicle identity independently from the nullable vehicle FK so paid
-- and approved production records remain understandable after inventory removal.
ALTER TABLE public.payout_entries
  ADD COLUMN vehicle_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(vehicle_snapshot) = 'object'
      AND octet_length(vehicle_snapshot::text) <= 65536);

UPDATE public.payout_entries AS payout
SET vehicle_snapshot = jsonb_strip_nulls(jsonb_build_object(
  'id', vehicle.id,
  'stock_number', vehicle.stock_number,
  'vin', vehicle.vin,
  'year', vehicle.year,
  'make', vehicle.make,
  'model', vehicle.model,
  'trim', vehicle.trim
))
FROM public.vehicles AS vehicle
WHERE payout.vehicle_id = vehicle.id
  AND payout.vehicle_snapshot = '{}'::jsonb;

CREATE OR REPLACE FUNCTION private.snapshot_payout_vehicle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.vehicle_id IS NOT NULL AND NEW.vehicle_snapshot = '{}'::jsonb THEN
    SELECT jsonb_strip_nulls(jsonb_build_object(
      'id', vehicle.id,
      'stock_number', vehicle.stock_number,
      'vin', vehicle.vin,
      'year', vehicle.year,
      'make', vehicle.make,
      'model', vehicle.model,
      'trim', vehicle.trim
    ))
    INTO NEW.vehicle_snapshot
    FROM public.vehicles AS vehicle
    WHERE vehicle.id = NEW.vehicle_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payout_entries_snapshot_vehicle
BEFORE INSERT ON public.payout_entries
FOR EACH ROW EXECUTE FUNCTION private.snapshot_payout_vehicle();

REVOKE ALL ON FUNCTION private.snapshot_payout_vehicle()
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delete_vehicle(_vehicle_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  target public.vehicles;
  target_store public.dealerships;
  existing_operation private.vehicle_deletion_operations;
  operation_id uuid := gen_random_uuid();
  media_ids uuid[] := ARRAY[]::uuid[];
  storage_objects jsonb := '[]'::jsonb;
  dependency_counts jsonb := '{}'::jsonb;
  cancelled_jobs integer := 0;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO target
  FROM public.vehicles
  WHERE id = _vehicle_id
  FOR UPDATE;

  IF target.id IS NULL THEN
    SELECT * INTO existing_operation
    FROM private.vehicle_deletion_operations
    WHERE vehicle_id = _vehicle_id;

    IF existing_operation.id IS NULL THEN
      RAISE EXCEPTION 'Vehicle is unavailable.' USING ERRCODE = 'P0002';
    END IF;

    IF NOT private.current_user_has_store_capability(
      existing_operation.dealership_id,
      'vehicle_delete'
    ) THEN
      RAISE EXCEPTION 'Vehicle is unavailable.' USING ERRCODE = '42501';
    END IF;

    RETURN jsonb_build_object(
      'status', 'already_deleted',
      'operation_id', existing_operation.id,
      'vehicle_id', existing_operation.vehicle_id,
      'storage_status', existing_operation.storage_status,
      'storage_object_count', jsonb_array_length(existing_operation.storage_manifest)
    );
  END IF;

  IF NOT private.current_user_has_store_capability(target.dealership_id, 'vehicle_delete') THEN
    RAISE EXCEPTION 'You do not have permission to delete this vehicle.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO target_store
  FROM public.dealerships
  WHERE id = target.dealership_id
  FOR SHARE;

  IF EXISTS (
    SELECT 1
    FROM public.photo_capture_sessions AS session
    WHERE session.vehicle_id = target.id
      AND session.status = 'in_progress'
  ) THEN
    RAISE EXCEPTION 'This vehicle has an active photo shoot or pending uploads. Finish or cancel that work before deleting the vehicle.'
      USING ERRCODE = '55000';
  END IF;

  SELECT coalesce(array_agg(asset.id), ARRAY[]::uuid[])
  INTO media_ids
  FROM public.media_assets AS asset
  WHERE asset.vehicle_id = target.id;

  IF EXISTS (
    SELECT 1
    FROM private.background_jobs AS job
    WHERE job.status = 'running'
      AND (
        (job.resource_type = 'media_asset' AND job.resource_id = ANY(media_ids))
        OR job.payload->>'vehicle_id' = target.id::text
        OR job.payload->>'media_asset_id' = ANY(SELECT unnest(media_ids)::text)
      )
  ) THEN
    RAISE EXCEPTION 'This vehicle has media processing in progress. Wait for it to finish before deleting the vehicle.'
      USING ERRCODE = '55000';
  END IF;

  WITH manifest AS (
    SELECT asset.storage_bucket AS bucket, asset.storage_object_path AS path
    FROM public.media_assets AS asset
    WHERE asset.vehicle_id = target.id
    UNION
    SELECT variant.storage_bucket, variant.storage_path
    FROM public.media_variants AS variant
    WHERE variant.media_asset_id = ANY(media_ids)
      AND variant.storage_bucket IS NOT NULL
      AND variant.storage_path IS NOT NULL
    UNION
    SELECT migration.source_bucket, migration.source_path
    FROM private.media_storage_migrations AS migration
    WHERE migration.media_asset_id = ANY(media_ids)
      AND migration.source_bucket IS NOT NULL
      AND migration.source_path IS NOT NULL
    UNION
    SELECT migration.destination_bucket, migration.destination_path
    FROM private.media_storage_migrations AS migration
    WHERE migration.media_asset_id = ANY(media_ids)
      AND migration.destination_bucket IS NOT NULL
      AND migration.destination_path IS NOT NULL
    UNION
    SELECT 'vehicle-photos'::text,
           split_part(urls.url, '/vehicle-photos/', 2)
    FROM public.photos AS photo
    CROSS JOIN LATERAL unnest(ARRAY[
      photo.image_url,
      photo.original_image_url,
      photo.cutout_image_url,
      photo.corrected_cutout_url
    ]) AS urls(url)
    WHERE photo.vehicle_id = target.id
      AND urls.url LIKE '%/vehicle-photos/%'
    UNION
    SELECT 'documents'::text, generated.storage_path
    FROM public.generated_documents AS generated
    WHERE generated.vehicle_id = target.id
      AND generated.storage_path IS NOT NULL
  ), cleaned AS (
    SELECT DISTINCT bucket, path
    FROM manifest
    WHERE bucket IS NOT NULL AND btrim(bucket) <> ''
      AND path IS NOT NULL AND btrim(path) <> ''
  )
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('bucket', bucket, 'path', path) ORDER BY bucket, path),
    '[]'::jsonb
  )
  INTO storage_objects
  FROM cleaned;

  SELECT jsonb_build_object(
    'photos', (SELECT count(*) FROM public.photos WHERE vehicle_id = target.id),
    'media_assets', coalesce(array_length(media_ids, 1), 0),
    'media_variants', (SELECT count(*) FROM public.media_variants WHERE media_asset_id = ANY(media_ids)),
    'generated_documents', (SELECT count(*) FROM public.generated_documents WHERE vehicle_id = target.id),
    'vehicle_documents', (SELECT count(*) FROM public.vehicle_documents WHERE vehicle_id = target.id),
    'completed_capture_sessions', (
      SELECT count(*) FROM public.photo_capture_sessions
      WHERE vehicle_id = target.id AND status IN ('completed','prepared')
    ),
    'payout_entries', (SELECT count(*) FROM public.payout_entries WHERE vehicle_id = target.id),
    'activity_events', (SELECT count(*) FROM public.activity_events WHERE vehicle_id = target.id),
    'storage_objects', jsonb_array_length(storage_objects)
  ) INTO dependency_counts;

  UPDATE private.background_jobs AS job
  SET status = 'cancelled',
      cancelled_at = now(),
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = 'vehicle_deleted',
      last_error_message = 'Cancelled because the vehicle was deleted.',
      updated_at = now()
  WHERE job.status IN ('queued','retry_scheduled')
    AND (
      (job.resource_type = 'media_asset' AND job.resource_id = ANY(media_ids))
      OR job.payload->>'vehicle_id' = target.id::text
      OR job.payload->>'media_asset_id' = ANY(SELECT unnest(media_ids)::text)
    );
  GET DIAGNOSTICS cancelled_jobs = ROW_COUNT;

  INSERT INTO private.vehicle_deletion_operations (
    id, vehicle_id, dealership_id, organization_id, requested_by,
    vehicle_snapshot, storage_manifest
  ) VALUES (
    operation_id, target.id, target.dealership_id, target_store.organization_id, actor_id,
    jsonb_strip_nulls(jsonb_build_object(
      'id', target.id,
      'stock_number', target.stock_number,
      'vin', target.vin,
      'year', target.year,
      'make', target.make,
      'model', target.model,
      'trim', target.trim
    )),
    storage_objects
  );

  -- Shared document-library rows are deliberately retained; only their vehicle
  -- attachment is removed by the vehicle cascade.
  DELETE FROM public.bulk_photo_items
  WHERE media_asset_id = ANY(media_ids)
     OR photo_id IN (SELECT id FROM public.photos WHERE vehicle_id = target.id);

  DELETE FROM public.photos WHERE vehicle_id = target.id;
  DELETE FROM public.media_variants WHERE media_asset_id = ANY(media_ids);
  DELETE FROM public.media_assets WHERE id = ANY(media_ids);

  -- Generated-document deletion refreshes readiness. Delete these records while
  -- the vehicle still exists so the trigger can evaluate a valid subject instead
  -- of firing from the vehicle's later ON DELETE CASCADE.
  DELETE FROM public.generated_documents WHERE vehicle_id = target.id;

  INSERT INTO public.activity_events (
    organization_id, dealership_id, vehicle_id, actor_profile_id,
    event_type, description, metadata
  ) VALUES (
    target_store.organization_id, target.dealership_id, target.id, actor_id,
    'vehicle.deleted',
    'Vehicle permanently deleted',
    jsonb_build_object(
      'operation_id', operation_id,
      'vehicle', jsonb_strip_nulls(jsonb_build_object(
        'id', target.id, 'stock_number', target.stock_number, 'vin', target.vin,
        'year', target.year, 'make', target.make, 'model', target.model, 'trim', target.trim
      )),
      'dependencies', dependency_counts,
      'cancelled_jobs', cancelled_jobs
    )
  );

  INSERT INTO public.audit_events (event_type, actor_profile_id, dealership_id, payload)
  VALUES (
    'vehicle.deleted', actor_id, target.dealership_id,
    jsonb_build_object(
      'operation_id', operation_id,
      'vehicle', jsonb_strip_nulls(jsonb_build_object(
        'id', target.id, 'stock_number', target.stock_number, 'vin', target.vin,
        'year', target.year, 'make', target.make, 'model', target.model, 'trim', target.trim
      )),
      'dependencies', dependency_counts,
      'cancelled_jobs', cancelled_jobs
    )
  );

  DELETE FROM public.vehicles WHERE id = target.id;

  INSERT INTO private.background_jobs (
    job_type, payload, dealership_id, resource_type, resource_id,
    priority, dedupe_key, created_by, max_attempts
  ) VALUES (
    'vehicle.storage.cleanup',
    jsonb_build_object('operation_id', operation_id),
    target.dealership_id,
    'vehicle_deletion',
    operation_id,
    50,
    'vehicle-storage-cleanup:' || operation_id::text,
    actor_id,
    10
  );

  RETURN jsonb_build_object(
    'status', 'deleted',
    'operation_id', operation_id,
    'vehicle_id', target.id,
    'storage_status', 'queued',
    'storage_object_count', jsonb_array_length(storage_objects),
    'cancelled_job_count', cancelled_jobs
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_get_vehicle_deletion_operation(_operation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  operation private.vehicle_deletion_operations;
BEGIN
  SELECT * INTO operation
  FROM private.vehicle_deletion_operations
  WHERE id = _operation_id
  FOR UPDATE;
  IF operation.id IS NULL THEN
    RAISE EXCEPTION 'Vehicle deletion operation is unavailable.' USING ERRCODE = 'P0002';
  END IF;
  IF operation.storage_status <> 'succeeded' THEN
    UPDATE private.vehicle_deletion_operations
    SET storage_status = 'running',
        storage_started_at = coalesce(storage_started_at, now()),
        safe_error_code = NULL,
        updated_at = now()
    WHERE id = operation.id;
  END IF;
  RETURN jsonb_build_object(
    'operation_id', operation.id,
    'vehicle_id', operation.vehicle_id,
    'storage_status', operation.storage_status,
    'storage_manifest', operation.storage_manifest
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_complete_vehicle_deletion_storage_cleanup(
  _operation_id uuid,
  _deleted_object_count integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE private.vehicle_deletion_operations
  SET storage_status = 'succeeded',
      storage_attempt_count = storage_attempt_count + 1,
      storage_completed_at = now(),
      safe_error_code = NULL,
      updated_at = now()
  WHERE id = _operation_id;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO public.audit_events (event_type, dealership_id, payload)
  SELECT 'vehicle.storage_cleanup_completed', operation.dealership_id,
         jsonb_build_object(
           'operation_id', operation.id,
           'vehicle_id', operation.vehicle_id,
           'deleted_object_count', greatest(coalesce(_deleted_object_count, 0), 0)
         )
  FROM private.vehicle_deletion_operations AS operation
  WHERE operation.id = _operation_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_fail_vehicle_deletion_storage_cleanup(
  _operation_id uuid,
  _safe_error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE private.vehicle_deletion_operations
  SET storage_status = 'failed',
      storage_attempt_count = storage_attempt_count + 1,
      safe_error_code = left(coalesce(nullif(btrim(_safe_error_code), ''), 'storage_cleanup_failed'), 120),
      updated_at = now()
  WHERE id = _operation_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_vehicle(uuid)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.delete_vehicle(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.worker_get_vehicle_deletion_operation(uuid)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_complete_vehicle_deletion_storage_cleanup(uuid, integer)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_fail_vehicle_deletion_storage_cleanup(uuid, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_get_vehicle_deletion_operation(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_complete_vehicle_deletion_storage_cleanup(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_fail_vehicle_deletion_storage_cleanup(uuid, text) TO service_role;

-- Force every application caller through the capability-checked workflow.
REVOKE DELETE ON public.vehicles FROM authenticated;

COMMENT ON FUNCTION public.delete_vehicle(uuid) IS
  'Permanently deletes an authorized vehicle, preserves historical evidence, and queues exact private Storage cleanup.';
COMMENT ON TABLE private.vehicle_deletion_operations IS
  'Durable outbox and audit record for non-transactional vehicle Storage cleanup.';
