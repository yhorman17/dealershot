# DealerShot Phase 1 release gate and manual testing handoff

This runbook is for disposable Supabase and non-production DigitalOcean resources only. It does not authorize a production migration, DNS change, merge to `main`, or Phase 2 work.

## Current gate status

On 2026-08-09, the connected Supabase account could not create a disposable hosted environment: both active Free project slots were occupied and preview branches required Pro. Both requests failed before creating a resource. The live DealerShot reference is `oyuvdarrkwpqmufzidnc`; the hosted runner refuses that reference.

Local verification applies the complete chain to disposable PostgreSQL 17 and exercises grants, RLS, Storage policy expressions, lifecycle procedures, settings, audit, and jobs. Real GoTrue, hosted JWT/session behavior, native Storage, email delivery, hosted extensions, and a deployed worker remain release gates until an independent hosted environment is available.

## 1. Create and prove the disposable environment

Either create a new Free project after a genuinely unused slot becomes available, or create a persistent data-less branch in a Pro non-production organization. Never pause/delete DealerShot or StudioGecko to free a slot. Never seed/copy production data or use `--with-data`.

Record the new reference; it must differ from `oyuvdarrkwpqmufzidnc`. In a visible local terminal, authenticate and link. Enter the database password only in the CLI prompt—not chat, source, or command history.

```powershell
supabase.cmd login
supabase.cmd projects list
supabase.cmd link --project-ref <DISPOSABLE_PROJECT_REF>
```

Inspect `supabase/.temp/linked-project.json` and confirm `ref` exactly matches the disposable project before any migration. Record project reference/region/status, Postgres version, existing schemas/tables/migration history, enabled/available extensions (especially `pgmq`, `pg_cron`, `pg_net`, `pg_graphql`, `pg_stat_statements`), and Database/Auth/API/Storage/Realtime health.

## 2. Apply and inspect the full migration chain

```powershell
supabase.cmd db push --linked --include-all --dry-run
supabase.cmd db push --linked --include-all
```

Apply every repository migration in filename order. The final Phase 1 migrations are:

1. `20260809201651_admin_provisioned_user_accounts.sql`
2. `20260809203613_phase_1_settings_and_durable_jobs.sql`
3. `20260809220000_harden_hosted_password_lifecycle.sql`

The first automatically backfills existing profiles as completed `existing` onboarding; no manual backfill is expected. The final migration adds reset containment/serialization. If its unique index finds duplicate active resets, reconcile them instead of weakening the migration.

Run [phase1_introspection.sql](../supabase/tests/hosted/phase1_introspection.sql) read-only in SQL Editor or via a database URL held only in the current process:

```powershell
psql.exe "$env:SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/hosted/phase1_introspection.sql
```

Compare migrations, tables, constraints, indexes, triggers, grants/revokes, RLS, policies, private-schema isolation, and fixed function search paths with the repository. Capture drift as a reviewed migration; do not repair it with ad hoc dashboard SQL.

## 3. Run real hosted acceptance

Put the disposable URL/keys only in the current terminal. The service-role key is secret.

```powershell
$env:DEALERSHOT_VALIDATION_PROJECT_REF = "<DISPOSABLE_PROJECT_REF>"
$env:DEALERSHOT_VALIDATION_CONFIRM = "validate-disposable:$env:DEALERSHOT_VALIDATION_PROJECT_REF"
$env:SUPABASE_URL = "https://<DISPOSABLE_PROJECT_REF>.supabase.co"
$env:SUPABASE_PUBLISHABLE_KEY = "<DISPOSABLE_PUBLISHABLE_KEY>"
$env:SUPABASE_SERVICE_ROLE_KEY = "<DISPOSABLE_SERVICE_ROLE_KEY>"
npm.cmd run test:hosted:phase1
```

The runner uses real Auth users/JWTs and tests tenant RLS, onboarding, Admin Auth replacement, existing-session containment, invitations, settings, append-only audit, Storage paths/public reads, and queue primitives. It never prints passwords, keys, JWTs, refresh tokens, or database credentials. Ordinary fixtures are removed by default; append-only audit/private job evidence remains until project destruction. Record its sanitized `existing_session_after_admin_password_update` result exactly—do not infer hosted behavior from local GoTrue.

Clear process secrets afterward:

```powershell
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY,Env:SUPABASE_PUBLISHABLE_KEY,Env:SUPABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:DEALERSHOT_VALIDATION_CONFIRM,Env:DEALERSHOT_VALIDATION_PROJECT_REF -ErrorAction SilentlyContinue
```

## 4. Auth configuration

- Disable anonymous sign-in and public email signup unless separately approved.
- Set Site URL to the exact testing origin.
- Add exact testing-origin `/accept-invite` and `/reset-password` redirects plus required localhost equivalents.
- Use at least 12 password characters and uppercase/lowercase/number/symbol requirements where hosted policy supports them.
- Keep invitation/email confirmation behavior enabled; Create Login Now confirms email server-side.
- Configure custom SMTP before relying on outbound delivery.
- Set `DEALERSHOT_PUBLIC_URL` to the exact HTTPS testing origin. Browser input never chooses invitation redirect hosts.

## 5. Bootstrap one disposable Owner

The product intentionally cannot create Owners. In the disposable dashboard, create one confirmed Auth email/password user using a private password. Then run this once with its UUID; never include the password in SQL.

```sql
BEGIN;
UPDATE public.profiles
SET role = 'owner'::public.app_role, dealership_id = NULL, status = 'active'
WHERE id = '<OWNER_AUTH_USER_UUID>'::uuid;

UPDATE public.user_onboarding
SET onboarding_method = 'existing', onboarding_state = 'complete',
    password_change_required = false, password_changed_at = now(),
    completed_at = now(), updated_at = now()
WHERE profile_id = '<OWNER_AUTH_USER_UUID>'::uuid;
COMMIT;
```

Verify exactly one intended active Owner. Create every Dealer Admin/Staff account through DealerShot thereafter.

## 6. Non-production DigitalOcean deployment

Deploy the reviewed feature branch and exact reported SHA—not `main`—to a separate test app. Do not modify live DealerShot. Keep Autodeploy off.

Web: root `Dockerfile`, default `node .output/server/index.mjs`, port 8080, `/health`, one `basic-xxs` instance.

Worker: same branch/SHA/image, `node .worker/index.mjs`, one `basic-xxs`, no HTTP port/route/ingress/hostname, Autodeploy off.

| Variable                           | Web build | Web runtime | Worker runtime | Encrypt |
| ---------------------------------- | --------: | ----------: | -------------: | ------: |
| `VITE_SUPABASE_URL`                |       yes |          no |             no |      no |
| `VITE_SUPABASE_PUBLISHABLE_KEY`    |       yes |          no |             no |      no |
| `SUPABASE_URL`                     |        no |         yes |            yes |      no |
| `SUPABASE_PUBLISHABLE_KEY`         |        no |         yes |             no |      no |
| `SUPABASE_SERVICE_ROLE_KEY`        |        no |         yes |            yes | **yes** |
| `DEALERSHOT_PUBLIC_URL`            |        no |         yes |             no |      no |
| `NODE_ENV=production`              |        no |         yes |            yes |      no |
| `HOST=0.0.0.0`, `PORT=8080`        |        no |         yes |             no |      no |
| `WORKER_POLL_INTERVAL_MS=2000`     |        no |          no |            yes |      no |
| `WORKER_LEASE_SECONDS=60`          |        no |          no |            yes |      no |
| `WORKER_METRICS_INTERVAL_MS=60000` |        no |          no |            yes |      no |

All Supabase values must belong to one disposable reference. Never use a `VITE_` service key or pass it as a Docker build argument.

## 7. Manual acceptance checklist

1. `/health` returns 200 and exactly `{"status":"ok"}`.
2. Sign in as Owner; create Dealership A/B.
3. Create Staff A with **Create Login Now**. Test reveal, copy email/password/login URL/all, then close; the password must not be recoverable.
4. Simulate lost response/idempotent retry: no old password may return/rotate. Explicit Reset issues a new one.
5. Create Dealer Admin A (A only), Dealer Admin B (B only), and multi-admin (A+B). Owner creation must be absent/rejected.
6. Temporary Staff login must route to `/change-password`. Direct dashboard/inventory/vehicle/documents/exports/users navigation and direct Data API calls expose no business data.
7. Set a different permanent password; require a fresh session if hosted Admin replacement revoked the old one, then only A access.
8. Keep Staff A signed in on device 1; reset from device 2. Device 1 Data API access stops before the new password is used. Old password fails; new temporary login is gated; second permanent password restores A only.
9. Dealer Admin A creates Staff A; cross-B Staff, Dealer Admin, Owner, Owner reset, and Staff B reset all fail. Staff cannot list/provision/reset/mutate access.
10. Send/accept a real invitation. Test server redirect origin, exact Auth email, wrong/NULL email, revoked/expired token, Owner role, cross tenant, and pristine placeholder restrictions.
11. Deactivate a user and suspend a dealership with live sessions; Data API access stops without JWT expiry.
12. Test Owner platform settings, allowed Dealer Admin A settings, forbidden keys, cross-B writes, Staff writes, and scoped reads.
13. Confirm provisioning/reset/deactivation/settings audit; ordinary and service-role update/delete fail; no credential/token appears.
14. Test Storage upload/update/delete for documents/overlays/backdrops/vehicle photos: own, cross-tenant, empty segment, encoded slash, unexpected depth, misleading prefix, cross-tenant vehicle, and user filename. Reviewed public reads stay unchanged.
15. At 390x844 test Add User, credentials dialog/copy controls, password change, keyboard/password manager, and no horizontal overflow; repeat core flows on desktop and another device.
16. Tab-switch during Auth/dialogs: no sign-out, global loading flash, or modal loss.
17. Inspect console, network URLs, local/session storage, HTML, analytics, and web/worker logs: no password, service key, access token, or refresh token persists/logs.

## 8. Worker/queue acceptance

The worker has no HTTP health endpoint. Prove health via `worker.started`, periodic safe metrics, and one `system.noop` lifecycle. Missing required env must exit without values. Validate claim/heartbeat/complete, duplicate enqueue, concurrent claims, retry/backoff, expired lease reclaim, max attempts/dead-letter, safe logs, and SIGTERM `worker.stopping` then `worker.stopped`.

Keep the private leased-job table for Phase 1. Record hosted PGMQ availability/version, but do not rewrite the queue now. Reconsider a thin PGMQ delivery layer after six days; authoritative state/authorization should remain in DealerShot tables.

## 9. Rollback/emergency disable

1. Turn off Autodeploy.
2. Scale the test worker to zero.
3. Roll web back to the last verified deployment/SHA.
4. Verify `/health`, `/login`, and protected routing.

Do not write destructive down migrations during an incident. Phase 1 is additive and existing profiles are backfilled complete. Leave onboarding/RLS helpers in place; dropping them weakens containment. Operationally disable Phase 1 by rolling back web and stopping worker. For disposable validation, save sanitized evidence and destroy the entire project/branch. Any production rollout needs a provider backup and separately reviewed recovery plan.

## 10. End of testing

Remove the temporary DigitalOcean app, destroy the disposable Supabase environment, clear environment variables, unlink the checkout, and verify no keys/credentials remain in files, profiles, logs, screenshots, clipboard history, or stashes. Triage/fix Phase 1 findings and repeat hosted acceptance before merging `main`. Phase 2 remains blocked until Priority #1 and Phase 1 have hosted evidence-backed approval.
