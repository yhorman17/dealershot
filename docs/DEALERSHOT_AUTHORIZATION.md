# DealerShot authorization model

## Decisions enforced in P0

- `owner` is a platform-wide role. The owner profile itself must be `active`.
- `dealer_admin` and `staff` are tenant roles. Their profile must be `active`, their `dealership_id` must match the row or Storage path being accessed, the dealership status must be `active` or `trial`, and `subscription_status` must be `active`.
- Authenticated browser code can update only `profiles.full_name`. Role, dealership assignment, and profile status changes use authenticated TanStack server functions and the server-only service-role client.
- New Auth users receive a pristine `staff` profile without a dealership. Invitation acceptance is the only non-owner workflow that may initialize the role and dealership; it requires a matching non-null Auth email, a pending unexpired invitation, a non-owner role, and an active dealership.
- Relationship policies verify both records belong to the same authorized dealership. Vehicle-photo Storage paths begin with a trusted vehicle UUID; overlay, backdrop, and document paths begin with a trusted dealership UUID.
- Existing public reads for vehicle photos, overlays, backdrops, and dealership logos remain intentional in P0. Documents remain private. Durable private-original storage belongs to the later image-pipeline phase and is not part of this change.

## Portable-suite boundary

`npm run test:security` creates an isolated PostgreSQL cluster, applies the full checked-in migration chain, then runs ordinary-user DML as a non-owner, non-superuser, non-`BYPASSRLS` `authenticated` role with `row_security = on`. It directly exercises table/column grants, RLS `USING` and `WITH CHECK`, relationship checks, Storage policy expressions, security-definer ACLs, and invitation RPC SQL.

The compatibility bootstrap is intentionally smaller than Supabase. It does not prove:

- hosted Supabase Auth JWT issuance, refresh, revocation, or session propagation;
- PostgREST/Data API claim translation and endpoint behavior;
- Storage API object-name decoding, normalization, overwrite semantics, or HTTP public-bucket delivery;
- dashboard-generated policy drift or service configuration in a real Supabase project.

Those boundaries require the disposable Supabase validation below. Production must never be used for this checklist.

## Disposable Supabase staging validation

1. Create a new disposable Supabase project, or start a clean local Supabase stack. Record its purpose and destruction date. Use only disposable keys and never copy production data or credentials.
2. Apply the complete `supabase/migrations` chain in filename order. Treat the authorization migration's policy-drift or unsupported-status exception as a stop condition; inspect and reconcile rather than bypassing it.
3. Create real Auth users and profiles for an active owner, dealership A administrator, dealership A staff user, dealership B staff user, deactivated user, and a user assigned to a suspended dealership. Also create active, trial, suspended, and inactive-subscription dealerships as needed.
4. Sign in each identity through Supabase Auth and retain separate real user JWT sessions. Use the publishable key plus each user's JWT for Data API requests; never substitute the service-role key for ordinary-user assertions.
5. Through the Data API, prove same-tenant SELECT/INSERT/UPDATE/DELETE behavior and denial of the same operations against the other dealership. Include an UPDATE that attempts to move a row to dealership B so `WITH CHECK` is exercised.
6. Through an authenticated Supabase Storage client, upload, overwrite/update, move, and delete objects in each governed bucket. Exercise authorized paths and cross-tenant paths, including empty, malformed, encoded-separator, misleading-prefix, and nested names.
7. Attempt direct updates of `profiles.role`, `profiles.dealership_id`, and `profiles.status` as staff and dealer administrator. Attempt self-promotion, promotion of another user, dealership reassignment, and owner invitation creation; all must fail.
8. Invoke every owner user-management server function with an active owner session, then repeat with staff, dealer administrator, deactivated owner, missing token, and invalid token. Only the active owner may reach the administrative operation.
9. Test invitation detail lookup and acceptance with a new email-matching Auth identity. Repeat with the wrong email, no email, expired/revoked invitation, owner role, unauthorized dealership, suspended dealership, and non-pristine profile.
10. Keep JWT sessions open while deactivating a user, suspending a dealership, and setting a dealership subscription inactive. Without refreshing those sessions, repeat Data API and Storage operations and confirm immediate denial.
11. Fetch existing public vehicle-photo, overlay, backdrop, and dealership-logo objects anonymously and confirm behavior is unchanged. Confirm documents are not anonymously readable and anonymous mutations fail.
12. Save sanitized results, delete all local credentials and artifacts, unlink the project if applicable, and destroy the disposable environment.
