# DealerShot Phase 1 release gate and manual testing handoff

This runbook covers disposable Supabase validation and the explicitly authorized DealerShot testing project. It does not authorize an unrelated Supabase project, unrelated DigitalOcean app, DNS change, merge to `main`, or Phase 2 work.

## Current gate status

On 2026-08-09, the DealerShot testing project `oyuvdarrkwpqmufzidnc` was explicitly authorized for an in-place Phase 1 migration and acceptance run. The hosted runner still refuses that protected reference by default; it accepts it only with the exact project-bound confirmation documented below.

Local verification applies the complete chain to disposable PostgreSQL 17 and exercises grants, RLS, Storage policy expressions, lifecycle procedures, settings, audit, and jobs. Real GoTrue, hosted JWT/session behavior, native Storage, email delivery, hosted extensions, and a deployed worker remain release gates until an independent hosted environment is available.

## 1. Prove the authorized environment

For the authorized DealerShot testing run, verify the reference is exactly `oyuvdarrkwpqmufzidnc` and the URL is exactly `https://oyuvdarrkwpqmufzidnc.supabase.co` before any mutation. For future disposable runs, create a separate project or persistent data-less branch and use the disposable confirmation path. Never pause/delete another project to free a slot, seed/copy production data, or use `--with-data`.

Record the exact authorized reference. In a visible local terminal, authenticate and link only when the database password can be entered at the CLI prompt—not in chat, source, or command history.

```powershell
supabase.cmd login
supabase.cmd projects list
supabase.cmd link --project-ref <DISPOSABLE_PROJECT_REF>
```

Inspect `supabase/.temp/linked-project.json` and confirm `ref` exactly matches the authorized project before any CLI migration. Record project reference/region/status, Postgres version, existing schemas/tables/migration history, enabled/available extensions (especially `pgmq`, `pg_cron`, `pg_net`, `pg_graphql`, `pg_stat_statements`), and Database/Auth/API/Storage/Realtime health.

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

Put the authorized URL/keys only in the current terminal. The service-role key is secret. Protected DealerShot validation requires the exact confirmation below; any typo or different protected reference fails closed.

```powershell
$env:DEALERSHOT_VALIDATION_PROJECT_REF = "oyuvdarrkwpqmufzidnc"
$env:DEALERSHOT_VALIDATION_CONFIRM = "validate-authorized-dealershot:oyuvdarrkwpqmufzidnc"
$env:SUPABASE_URL = "https://oyuvdarrkwpqmufzidnc.supabase.co"
$env:SUPABASE_PUBLISHABLE_KEY = "<DEALERSHOT_PUBLISHABLE_KEY>"
$env:SUPABASE_SERVICE_ROLE_KEY = "<DEALERSHOT_SERVICE_ROLE_KEY>"
npm.cmd run test:hosted:phase1
```

For a disposable project, retain `validate-disposable:<project-ref>` instead. The protected confirmation is not a wildcard and does not authorize any other project.

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

## 5. Bootstrap one Owner only if none exists

The product intentionally cannot create Owners. First reuse the existing valid active Owner. Only when none exists, create one confirmed Auth email/password user using a private password and run the documented bootstrap once with its UUID; never include the password in SQL.

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

## 6. DealerShot DigitalOcean testing deployment

Deploy the reviewed feature branch and exact reported SHA—not `main`—to the existing DealerShot testing app serving `https://dealershot.studiogecko.dev`. Do not modify unrelated apps or DNS. Keep Autodeploy off.

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
