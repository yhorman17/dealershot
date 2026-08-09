\set ON_ERROR_STOP on

\echo 'DealerShot hosted Phase 1 introspection (read-only)'

SELECT current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       current_setting('row_security') AS row_security;

SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE name IN ('pgmq', 'pg_cron', 'pg_net', 'pg_graphql', 'pg_stat_statements', 'uuid-ossp', 'pgcrypto')
ORDER BY name;

SELECT extname, extversion
FROM pg_extension
ORDER BY extname;

SELECT version
FROM supabase_migrations.schema_migrations
ORDER BY version;

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(required_name ORDER BY required_name)
  INTO missing
  FROM unnest(ARRAY[
    'audit_events',
    'dealership_settings',
    'platform_settings',
    'user_account_operation_dealerships',
    'user_account_operations',
    'user_onboarding'
  ]) AS required_name
  WHERE to_regclass('public.' || required_name) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Missing required Phase 1 tables: %', missing;
  END IF;

  IF to_regclass('private.background_jobs') IS NULL
     OR to_regclass('private.background_job_attempts') IS NULL
     OR to_regclass('private.idempotency_records') IS NULL THEN
    RAISE EXCEPTION 'Private Phase 1 job foundation is incomplete.';
  END IF;
END;
$$;

SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname IN ('public', 'private')
ORDER BY n.nspname, c.relname;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname IN ('public', 'storage')
ORDER BY schemaname, tablename, policyname;

SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       p.prosecdef AS security_definer,
       p.proconfig AS function_configuration,
       pg_get_userbyid(p.proowner) AS owner
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'private')
  AND p.proname IN (
    'accept_invitation',
    'admin_set_dealership_setting',
    'admin_set_platform_setting',
    'begin_temporary_password_reset_operation',
    'begin_user_provisioning_operation',
    'complete_temporary_password_onboarding',
    'contain_temporary_password_reset_operation',
    'enqueue_background_job',
    'finalize_temporary_password_reset_operation',
    'finalize_user_provisioning_operation',
    'worker_claim_background_job',
    'worker_complete_background_job',
    'worker_fail_background_job',
    'worker_get_queue_metrics',
    'worker_heartbeat_background_job'
  )
ORDER BY n.nspname, p.proname;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private')
      AND p.prosecdef
      AND p.proname IN (
        'accept_invitation',
        'admin_set_dealership_setting',
        'admin_set_platform_setting',
        'begin_temporary_password_reset_operation',
        'begin_user_provisioning_operation',
        'complete_temporary_password_onboarding',
        'contain_temporary_password_reset_operation',
        'enqueue_background_job',
        'finalize_temporary_password_reset_operation',
        'finalize_user_provisioning_operation',
        'worker_claim_background_job',
        'worker_complete_background_job',
        'worker_fail_background_job',
        'worker_get_queue_metrics',
        'worker_heartbeat_background_job'
      )
      AND NOT ('search_path=""' = ANY (COALESCE(p.proconfig, ARRAY[]::text[])))
  ) THEN
    RAISE EXCEPTION 'A reviewed SECURITY DEFINER function lacks a fixed empty search path.';
  END IF;
END;
$$;

SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee IN ('anon', 'authenticated', 'service_role')
  AND table_schema IN ('public', 'private')
  AND table_name IN (
    'audit_events',
    'background_job_attempts',
    'background_jobs',
    'dealership_settings',
    'idempotency_records',
    'platform_settings',
    'user_account_operation_dealerships',
    'user_account_operations',
    'user_onboarding'
  )
ORDER BY grantee, table_schema, table_name, privilege_type;

\echo 'Hosted Phase 1 introspection completed.'
