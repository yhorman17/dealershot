# DealerShot expansion Phase 1 foundation

This document covers the reviewed admin-provisioned account flow and the common Phase 1 infrastructure. It does not authorize applying migrations or changing a live environment. Payroll, media migration, storage quotas, lifecycle automation, exports, and syndication remain out of scope.

## Admin-provisioned accounts

The browser calls authenticated TanStack server functions. The server verifies the Supabase access token with Auth, derives the actor ID from that verified token, independently loads the actor's active profile/onboarding/dealership scope, and then invokes service-only database procedures. The service-role key stays in the server runtime.

| Actor               | Create now                                             | Reset temporary password                            | Deactivate                    |
| ------------------- | ------------------------------------------------------ | --------------------------------------------------- | ----------------------------- |
| Active Owner        | Dealer Admin or Staff in authorized active dealerships | Any eligible non-Owner                              | Any eligible non-self account |
| Active Dealer Admin | Staff in an actively assigned dealership only          | Staff whose primary dealership is actively assigned | Permitted Staff only          |
| Staff               | Never                                                  | Never                                               | Never                         |

`Create Login Now` generates a 20-character password in server memory using `node:crypto.randomInt`. The generated value is passed directly to Supabase Auth and returned only in the successful response. It is not placed in profile metadata, SQL arguments, database rows, URLs, logs, analytics, local storage, or session storage. Closing the one-time credentials dialog clears component state. Invitations remain a separate supported path.

The `user_account_operations` record is created before crossing the Auth boundary. Reusing an idempotency key with identical input returns the durable status but never returns or rotates the original credential. Reusing it for different input is rejected. Provider timeouts become `needs_reconciliation`; a possibly created Auth identity remains a pristine password-gated profile through the Auth trigger. Password reset containment commits before the external GoTrue call, so existing JWTs lose business-data access before a credential changes. Active resets are serialized per target, and role/dealership access cannot move while a reset is in flight.

Admin-provisioned users authenticate normally but business RLS helpers require a completed `user_onboarding` row. Until the user changes the password, only their own profile/onboarding state and the password screen are available. The server binds hosted Admin password replacement to the Auth-verified caller ID, and the browser establishes a fresh session because hosted Admin replacement may revoke the entering session. Existing profiles are backfilled as complete. Invitation acceptance remains distinct and completes invitation onboarding after validating the signed-in Auth email, invitation role, active dealership, and pristine placeholder profile.

### Reconciliation runbook

1. Use a non-browser, service-authorized operational session. Never paste credentials into SQL or logs.
2. Find operations with `status = 'needs_reconciliation'`; correlate by operation ID, safe error code, target email, actor, and timestamps.
3. For provisioning, verify the Auth user and placeholder/profile state. If Auth creation succeeded, call the existing finalize procedure with the exact Auth user ID. If the original credential response was lost, do not retry provisioning; issue an explicit new temporary-password reset.
4. For reset uncertainty, the account is already blocked from business RLS. Perform a new reset with a new idempotency key after confirming the target. Do not attempt to recover the old plaintext password.
5. Confirm the new operation is complete, `password_change_required = true`, and a safe audit event exists. Never change operation rows manually in production.

## Settings and audit

`platform_settings` is readable only by active Owners and writable only through the service-only Owner procedure. `dealership_settings` has an explicit `owner_admin` or `active_members` read scope. Dealer Admin writes are restricted to actively assigned dealerships and this allowlist:

- `dealership.timezone`
- `payroll.week_start`
- `staff.self_pay_visibility`
- `workflow.replacement_credit_policy`
- `lifecycle.publishing_policy`
- `user_provisioning.staff_enabled`

Owners may establish other future keys. No secret, credential, token, or private integration payload belongs in either settings table.

`audit_events` is append-only through an update/delete rejection trigger as well as restricted grants. Events contain safe correlation metadata, not passwords, Auth tokens, invitation tokens, service keys, or complete sensitive request payloads.

## Durable jobs and queue decision

Authoritative job and attempt state lives in the non-API `private` schema. Claims use `FOR UPDATE SKIP LOCKED`, leases, heartbeats, bounded exponential retry, attempt history, and dead-letter state. Dedupe keys prevent duplicate enqueue for the same job type. Queue metrics expose counts, oldest ready work, expired leases, average completed duration, and account operations needing reconciliation without exposing job payloads.

Supabase Queues/PGMQ was evaluated but not selected in this migration because the available extension set has not been verified in a real disposable DealerShot Supabase environment. Enabling an unverified extension would make the migration environment-dependent. The private PostgreSQL leased-job table is the approved portable fallback and remains authoritative. Re-evaluate a thin PGMQ delivery layer only after native staging confirms availability; delivery messages should contain a job ID while handlers reload and authorize the authoritative record.

The worker registers only `system.noop`. Unknown job types are dead-lettered rather than interpreted. No photo processing, export, payroll, or publishing handler exists.

## DigitalOcean worker configuration

The app spec defines a separate non-routable `background-worker` component using the same Docker image and `node .worker/index.mjs`. The web command, port, ingress, and health check are unchanged. The worker uses graceful `SIGTERM`/`SIGINT` shutdown and structured JSON logs.

Configure these as encrypted runtime variables on the worker (or inherited encrypted app-level variables) in a non-production validation app before enabling it:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Non-secret tuning variables are `WORKER_POLL_INTERVAL_MS`, `WORKER_LEASE_SECONDS`, and `WORKER_METRICS_INTERVAL_MS`. Never give the service-role key a `VITE_` prefix. Repository app-spec changes do nothing to DigitalOcean until an operator explicitly applies/deploys them.

## Disposable Supabase validation gate

The executable hosted runner, live-project safety interlock, complete deployment handoff, and rollback procedure are in [DEALERSHOT_PHASE_1_RELEASE_GATE.md](./DEALERSHOT_PHASE_1_RELEASE_GATE.md).

1. Create a new disposable Supabase project or clean local stack; use disposable credentials and data only.
2. Confirm Queue/PGMQ extension availability for the recorded architecture decision, but do not change the checked-in fallback during validation.
3. Apply the full migration chain in filename order and stop on any drift or constraint error.
4. Create real Auth users for Owner, multi-dealership Dealer Admin, Dealer A Staff, Dealer B Staff, deactivated Staff, suspended-dealership Staff, and a new admin-provisioned temporary user.
5. With each real JWT and the publishable client, exercise profile/onboarding reads plus ordinary Data API CRUD. Confirm RLS is enabled and the ordinary role is not service/superuser/BYPASSRLS/table owner.
6. Create Staff and Dealer Admin accounts as Owner. Create Staff as Dealer Admin in each assigned dealership. Attempt Owner creation, Dealer Admin creation by Dealer Admin, cross-tenant assignment/reset, Owner reset, and Staff administration; all prohibited cases must fail server-side.
7. Sign in using a returned temporary credential. Directly query business tables with that JWT and confirm denial, change the password, confirm onboarding completion, then confirm normal scoped access.
8. Reset an account while its old session remains active and confirm that same JWT immediately loses business-table access until password onboarding completes again.
9. Repeat idempotency keys, simulate a lost response, inspect reconciliation state, and verify no retry returns or rotates the original credential.
10. Test the invitation flow with a real Auth invitation/magic-link session and verify email/role/dealership validation and completed access.
11. Exercise Storage upload/update/delete with real clients, including cross-tenant and malformed paths, and confirm public-read behavior is unchanged.
12. Enqueue only `system.noop`, run one worker, confirm claim/heartbeat/complete; inject retryable and terminal failures, lease expiry, max attempts, dead-letter count, safe logs, and metrics.
13. Validate Owner/platform and Dealer Admin/dealership settings, read scopes, allowlist denials, and append-only audit enforcement.
14. Re-run login tab-switch/session-preservation, desktop/mobile Users dialogs, copy controls, password-manager semantics, `/health`, and console/log credential scans.
15. Destroy the disposable Auth users, database, Storage objects, keys, and project/app after collecting sanitized evidence.

## Portable-suite limitations

The portable PostgreSQL 17 suite executes the migration chain, real grants, RLS `USING`/`WITH CHECK`, Security Definer permissions, Storage policy expressions, account operations, settings, and job lifecycle under non-owner roles. It does not run GoTrue, issue/refresh/revoke real Supabase JWTs, exercise Supabase Admin API transport behavior, deliver emails, execute the native Storage API, prove hosted extension availability, or run a real DigitalOcean worker. Those remain staging release gates.
