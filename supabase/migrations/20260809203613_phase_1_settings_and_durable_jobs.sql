-- Common Phase 1 foundation: scoped settings, reusable idempotency records,
-- durable private background jobs, attempts, leases, retries, and metrics.
-- This migration creates infrastructure only; no media/payroll/syndication
-- workload is implemented or enqueued.

CREATE TABLE public.platform_settings (
  setting_key text PRIMARY KEY CHECK (setting_key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  setting_value jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(setting_value::text) <= 65536),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.dealership_settings (
  dealership_id uuid NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  setting_key text NOT NULL CHECK (setting_key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  setting_value jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(setting_value::text) <= 65536),
  read_scope text NOT NULL DEFAULT 'owner_admin'
    CHECK (read_scope IN ('owner_admin', 'active_members')),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dealership_id, setting_key)
);

CREATE INDEX dealership_settings_updated_idx
  ON public.dealership_settings (dealership_id, updated_at DESC);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dealership_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.dealership_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.platform_settings, public.dealership_settings TO authenticated;
GRANT ALL ON public.platform_settings, public.dealership_settings TO service_role;

CREATE POLICY "Active owners read platform settings"
ON public.platform_settings FOR SELECT TO authenticated
USING ((SELECT private.current_user_is_active_owner()));

CREATE POLICY "Active members read dealership settings"
ON public.dealership_settings FOR SELECT TO authenticated
USING (
  (SELECT private.current_user_is_active_owner())
  OR private.current_user_is_dealership_admin(dealership_id)
  OR (
    read_scope = 'active_members'
    AND private.current_user_has_active_membership(dealership_id)
  )
);

CREATE OR REPLACE FUNCTION private.prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are append-only.' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION private.prevent_audit_event_mutation();
REVOKE ALL ON FUNCTION private.prevent_audit_event_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE private.idempotency_records (
  scope text NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) BETWEEN 16 AND 128),
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'complete', 'needs_reconciliation', 'failed')),
  safe_response jsonb CHECK (safe_response IS NULL OR octet_length(safe_response::text) <= 65536),
  safe_error_code text CHECK (safe_error_code IS NULL OR length(safe_error_code) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE private.background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL CHECK (job_type ~ '^[a-z][a-z0-9_.-]{2,119}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144),
  dealership_id uuid REFERENCES public.dealerships(id) ON DELETE RESTRICT,
  resource_type text CHECK (resource_type IS NULL OR resource_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  resource_id uuid,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'retry_scheduled', 'succeeded', 'dead_letter', 'cancelled')),
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 25),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) <= 160),
  lease_expires_at timestamptz,
  dedupe_key text CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200),
  trace_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  safe_result jsonb CHECK (safe_result IS NULL OR octet_length(safe_result::text) <= 262144),
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 120),
  last_error_message text CHECK (last_error_message IS NULL OR length(last_error_message) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (job_type, dedupe_key),
  CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running')
  ),
  CHECK ((resource_type IS NULL) = (resource_id IS NULL))
);

CREATE TABLE private.background_job_attempts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES private.background_jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL,
  outcome text NOT NULL DEFAULT 'running'
    CHECK (outcome IN ('running', 'succeeded', 'retry_scheduled', 'dead_letter', 'lease_expired')),
  safe_error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (job_id, attempt_number)
);

CREATE INDEX background_jobs_claim_idx
  ON private.background_jobs (priority DESC, available_at, created_at)
  WHERE status IN ('queued', 'retry_scheduled');
CREATE INDEX background_jobs_expired_lease_idx
  ON private.background_jobs (lease_expires_at)
  WHERE status = 'running';
CREATE INDEX background_jobs_dealership_idx
  ON private.background_jobs (dealership_id, created_at DESC)
  WHERE dealership_id IS NOT NULL;
CREATE INDEX background_job_attempts_job_idx
  ON private.background_job_attempts (job_id, attempt_number DESC);
CREATE INDEX idempotency_records_expiry_idx
  ON private.idempotency_records (expires_at)
  WHERE expires_at IS NOT NULL;

REVOKE ALL ON private.idempotency_records FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.background_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.background_job_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE private.background_job_attempts_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.idempotency_records TO service_role;
GRANT ALL ON private.background_jobs TO service_role;
GRANT ALL ON private.background_job_attempts TO service_role;
GRANT ALL ON SEQUENCE private.background_job_attempts_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.admin_set_platform_setting(
  _actor_id uuid,
  _setting_key text,
  _setting_value jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (SELECT private.actor_is_active_owner(_actor_id)) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF _setting_key !~ '^[a-z][a-z0-9_.-]{1,79}$' OR jsonb_typeof(_setting_value) IS NULL THEN
    RAISE EXCEPTION 'Invalid setting.';
  END IF;
  INSERT INTO public.platform_settings (setting_key, setting_value, updated_by)
  VALUES (_setting_key, _setting_value, _actor_id)
  ON CONFLICT (setting_key) DO UPDATE SET
    setting_value = EXCLUDED.setting_value,
    updated_by = EXCLUDED.updated_by,
    updated_at = now();
  INSERT INTO public.audit_events (event_type, actor_profile_id, payload)
  VALUES ('setting.platform_updated', _actor_id, jsonb_build_object('setting_key', _setting_key));
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_dealership_setting(
  _actor_id uuid,
  _dealership_id uuid,
  _setting_key text,
  _setting_value jsonb,
  _read_scope text DEFAULT 'owner_admin'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_is_owner boolean := (SELECT private.actor_is_active_owner(_actor_id));
BEGIN
  IF NOT (
    actor_is_owner
    OR (SELECT private.actor_is_active_dealer_admin_for(_actor_id, _dealership_id))
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF _setting_key !~ '^[a-z][a-z0-9_.-]{1,79}$' OR jsonb_typeof(_setting_value) IS NULL THEN
    RAISE EXCEPTION 'Invalid setting.';
  END IF;
  IF _read_scope NOT IN ('owner_admin', 'active_members') THEN
    RAISE EXCEPTION 'Invalid setting read scope.';
  END IF;
  IF NOT actor_is_owner AND _setting_key NOT IN (
    'dealership.timezone',
    'payroll.week_start',
    'staff.self_pay_visibility',
    'workflow.replacement_credit_policy',
    'lifecycle.publishing_policy',
    'user_provisioning.staff_enabled'
  ) THEN
    RAISE EXCEPTION 'Dealer administrators cannot modify this setting.';
  END IF;
  INSERT INTO public.dealership_settings (
    dealership_id, setting_key, setting_value, read_scope, updated_by
  ) VALUES (_dealership_id, _setting_key, _setting_value, _read_scope, _actor_id)
  ON CONFLICT (dealership_id, setting_key) DO UPDATE SET
    setting_value = EXCLUDED.setting_value,
    read_scope = EXCLUDED.read_scope,
    updated_by = EXCLUDED.updated_by,
    updated_at = now();
  INSERT INTO public.audit_events (
    event_type, actor_profile_id, dealership_id, payload
  ) VALUES (
    'setting.dealership_updated', _actor_id, _dealership_id,
    jsonb_build_object('setting_key', _setting_key)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_background_job(
  _job_type text,
  _payload jsonb DEFAULT '{}'::jsonb,
  _dealership_id uuid DEFAULT NULL,
  _dedupe_key text DEFAULT NULL,
  _trace_id uuid DEFAULT gen_random_uuid(),
  _max_attempts integer DEFAULT 5,
  _priority smallint DEFAULT 0,
  _created_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job private.background_jobs%ROWTYPE;
BEGIN
  IF _job_type !~ '^[a-z][a-z0-9_.-]{2,119}$' OR jsonb_typeof(_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid job request.';
  END IF;
  IF _max_attempts NOT BETWEEN 1 AND 25 OR _priority NOT BETWEEN -100 AND 100 THEN
    RAISE EXCEPTION 'Invalid retry or priority configuration.';
  END IF;
  IF _dedupe_key IS NOT NULL AND length(_dedupe_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid deduplication key.';
  END IF;
  IF _dealership_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.dealerships WHERE id = _dealership_id
  ) THEN RAISE EXCEPTION 'Dealership not found.'; END IF;

  INSERT INTO private.background_jobs (
    job_type, payload, dealership_id, dedupe_key, trace_id,
    max_attempts, priority, created_by
  ) VALUES (
    _job_type, _payload, _dealership_id, NULLIF(_dedupe_key, ''), _trace_id,
    _max_attempts, _priority, _created_by
  )
  ON CONFLICT (job_type, dedupe_key) DO NOTHING
  RETURNING * INTO job;

  IF NOT FOUND THEN
    SELECT * INTO job FROM private.background_jobs
    WHERE job_type = _job_type AND dedupe_key = _dedupe_key;
  END IF;
  RETURN jsonb_build_object('job_id', job.id, 'status', job.status, 'trace_id', job.trace_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_claim_background_job(
  _worker_id text,
  _lease_seconds integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job private.background_jobs%ROWTYPE;
BEGIN
  IF NULLIF(btrim(_worker_id), '') IS NULL OR length(_worker_id) > 160
     OR _lease_seconds NOT BETWEEN 15 AND 900 THEN
    RAISE EXCEPTION 'Invalid worker lease.';
  END IF;

  UPDATE private.background_job_attempts AS a
  SET outcome = 'lease_expired', completed_at = now()
  FROM private.background_jobs AS j
  WHERE a.job_id = j.id
    AND a.attempt_number = j.attempt_count
    AND a.outcome = 'running'
    AND j.status = 'running'
    AND j.lease_expires_at <= now();

  UPDATE private.background_jobs
  SET status = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
      last_error_code = 'lease_expired_max_attempts', updated_at = now(), completed_at = now()
  WHERE status = 'running' AND lease_expires_at <= now() AND attempt_count >= max_attempts;

  SELECT * INTO job
  FROM private.background_jobs
  WHERE (
      status IN ('queued', 'retry_scheduled') AND available_at <= now()
    ) OR (
      status = 'running' AND lease_expires_at <= now() AND attempt_count < max_attempts
    )
  ORDER BY priority DESC, available_at, created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE private.background_jobs
  SET status = 'running',
      attempt_count = attempt_count + 1,
      lease_owner = btrim(_worker_id),
      lease_expires_at = now() + make_interval(secs => _lease_seconds),
      started_at = COALESCE(started_at, now()),
      updated_at = now()
  WHERE id = job.id
  RETURNING * INTO job;

  INSERT INTO private.background_job_attempts (job_id, attempt_number, worker_id)
  VALUES (job.id, job.attempt_count, btrim(_worker_id));

  RETURN jsonb_build_object(
    'job_id', job.id,
    'job_type', job.job_type,
    'payload', job.payload,
    'dealership_id', job.dealership_id,
    'attempt', job.attempt_count,
    'max_attempts', job.max_attempts,
    'trace_id', job.trace_id,
    'lease_expires_at', job.lease_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_heartbeat_background_job(
  _worker_id text,
  _job_id uuid,
  _lease_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE private.background_jobs
  SET lease_expires_at = now() + make_interval(secs => _lease_seconds), updated_at = now()
  WHERE id = _job_id AND status = 'running' AND lease_owner = _worker_id
    AND _lease_seconds BETWEEN 15 AND 900
  RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.worker_complete_background_job(
  _worker_id text,
  _job_id uuid,
  _safe_result jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  attempt integer;
BEGIN
  UPDATE private.background_jobs
  SET status = 'succeeded', safe_result = _safe_result,
      lease_owner = NULL, lease_expires_at = NULL,
      updated_at = now(), completed_at = now()
  WHERE id = _job_id AND status = 'running' AND lease_owner = _worker_id
  RETURNING attempt_count INTO attempt;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE private.background_job_attempts
  SET outcome = 'succeeded', completed_at = now()
  WHERE job_id = _job_id AND attempt_number = attempt AND outcome = 'running';
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_fail_background_job(
  _worker_id text,
  _job_id uuid,
  _safe_error_code text,
  _retryable boolean DEFAULT true
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job private.background_jobs%ROWTYPE;
  next_status text;
BEGIN
  SELECT * INTO job FROM private.background_jobs
  WHERE id = _job_id AND status = 'running' AND lease_owner = _worker_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_owned'; END IF;

  next_status := CASE
    WHEN _retryable AND job.attempt_count < job.max_attempts THEN 'retry_scheduled'
    ELSE 'dead_letter'
  END;
  UPDATE private.background_jobs
  SET status = next_status,
      available_at = CASE WHEN next_status = 'retry_scheduled'
        THEN now() + make_interval(secs => LEAST(300, (5 * power(2, job.attempt_count - 1))::integer))
        ELSE available_at END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = left(COALESCE(_safe_error_code, 'unknown_error'), 120),
      updated_at = now(),
      completed_at = CASE WHEN next_status = 'dead_letter' THEN now() ELSE NULL END
  WHERE id = job.id;
  UPDATE private.background_job_attempts
  SET outcome = next_status,
      safe_error_code = left(COALESCE(_safe_error_code, 'unknown_error'), 120),
      completed_at = now()
  WHERE job_id = job.id AND attempt_number = job.attempt_count AND outcome = 'running';
  RETURN next_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_get_queue_metrics()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'queued', count(*) FILTER (WHERE j.status = 'queued'),
    'retry_scheduled', count(*) FILTER (WHERE j.status = 'retry_scheduled'),
    'running', count(*) FILTER (WHERE j.status = 'running'),
    'expired_leases', count(*) FILTER (
      WHERE j.status = 'running' AND j.lease_expires_at <= now()
    ),
    'dead_letter', count(*) FILTER (WHERE j.status = 'dead_letter'),
    'average_duration_seconds', COALESCE(avg(EXTRACT(epoch FROM (j.completed_at - j.started_at))) FILTER (
      WHERE j.status = 'succeeded' AND j.started_at IS NOT NULL AND j.completed_at IS NOT NULL
    ), 0),
    'oldest_ready_at', min(j.available_at) FILTER (
      WHERE j.status IN ('queued', 'retry_scheduled') AND j.available_at <= now()
    ),
    'account_operations_needing_reconciliation', (
      SELECT count(*) FROM public.user_account_operations AS o
      WHERE o.status = 'needs_reconciliation'
    ),
    'oldest_account_reconciliation_at', (
      SELECT min(o.updated_at) FROM public.user_account_operations AS o
      WHERE o.status = 'needs_reconciliation'
    )
  )
  FROM private.background_jobs AS j;
$$;

REVOKE ALL ON FUNCTION public.admin_set_platform_setting(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_dealership_setting(uuid, uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_background_job(text, jsonb, uuid, text, uuid, integer, smallint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_claim_background_job(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_heartbeat_background_job(text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_complete_background_job(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_fail_background_job(text, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.worker_get_queue_metrics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_platform_setting(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_dealership_setting(uuid, uuid, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_background_job(text, jsonb, uuid, text, uuid, integer, smallint, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_claim_background_job(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_heartbeat_background_job(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_complete_background_job(text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_fail_background_job(text, uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.worker_get_queue_metrics() TO service_role;
