# DealerShot Baseline Audit

**Audit date:** 2026-08-04

**Repository:** `yhorman17/dealershot`

**Source of truth:** `origin/main` at `5c11faed0dc3d6cd3195b2121d760732286afb11`
**Scope:** read-only application/database review plus this document, the roadmap, and README; no application, migration, remote Supabase, production-data, commit, or push changes.

## Skills applied

- **Impeccable:** product-quality, responsive, accessibility, interaction-state, and UI anti-pattern review. The supplied product brief served as context; no extra `PRODUCT.md` was created because only three documentation deliverables were authorized.
- **Supabase:** authentication, client/server boundary, Row Level Security, Storage, and service-role review.
- **Supabase PostgreSQL best practices:** policy design, privileges, constraints, indexes, concurrency, and transaction review.
- **In-app browser control:** local desktop/mobile runtime checks, protected-route redirects, auth recovery states, focus behavior, overflow, and touch-target measurements.
- **Task observer:** maintained a reproducible audit trail and checked for recurring audit hazards without changing the product.

The installed skill catalog was inspected before work. No installed skill was a closer framework-specific match for TanStack Start, VIN camera capture, image processing, or testing, so those areas were reviewed directly from source, built artifacts, and runtime behavior rather than invoking unrelated skills.

## Executive summary

DealerShot is a functioning vertical slice, not an empty foundation: inventory, VIN capture/decoding, guided and free photo intake, client-side cutout/editing, reusable documents, exports, and owner administration are all represented. A frozen Bun install and production build succeed. The local unauthenticated journeys render at desktop and 390 px mobile widths without horizontal overflow, and protected routes redirect to login.

The application is **not production-ready (32/100)** and new feature development should pause. Two confirmed P0 authorization failures allow a signed-in user to promote their own profile to `owner`, while deactivated users and suspended dealerships are not enforced at the database boundary. Several P1 media paths can lose originals, strand processing, break private document rendering/export, or leave storage orphaned. There are no automated tests; independent TypeScript checking fails; lint is overwhelmed by line-ending failures; and the dependency audit reports 32 advisories including one critical production dependency.

This assessment is conservative. It is based on the checked-in migration sequence and source code. The live Supabase schema and cross-tenant behavior were not mutated or tested because no disposable tenant credentials or linked non-production project were supplied.

### Containment implementation update — 2026-08-04

The 32/100 score and evidence below remain the original baseline snapshot. The P0 implementation on this branch remediates F-01 and F-02 through migration `20260804051336_enforce_active_tenant_authorization.sql` and exercises the controls in `supabase/tests/portable/authorization_assertions.sql`. F-10 is also contained by same-tenant vehicle/document checks. The migration has been validated only in a disposable local PostgreSQL cluster; it has not been applied to a live or staging Supabase project.

The containment model is:

- only active platform owners have global administrative access;
- active dealer users require an `active` or `trial` dealership whose `subscription_status` is `active`;
- deactivated profiles and suspended/inactive dealerships are denied at table and Storage write policy boundaries;
- browser clients have direct `profiles` update privilege only for `full_name`;
- protected profile changes run through authenticated server functions that re-check the caller with the server-only service-role client;
- public bucket reads remain intentionally unchanged for runtime compatibility, while all cross-tenant writes are denied.

## Repository and environment baseline

| Item                     | Confirmed result                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Branch                   | `main`                                                                                                                           |
| Local HEAD               | `5c11faed0dc3d6cd3195b2121d760732286afb11`                                                                                       |
| `origin/main`            | Same SHA after `git fetch origin main`                                                                                           |
| Remote                   | `origin https://github.com/yhorman17/dealershot.git`                                                                             |
| Initial status           | Clean, `main...origin/main`; no untracked files                                                                                  |
| Ignored runtime output   | `node_modules`, `dist`, `.output`, `.vinxi`, `.tanstack`, `.nitro`, logs and local env variants                                  |
| Branches                 | Local `main`; remote `origin/main`                                                                                               |
| Recent commits           | `5c11fae` README, `220e18f` application import, `760f8bf` env update, `057829b` lock/config work, `f252837` mobile tab drift fix |
| Runtime observed         | Node `v24.16.0`; npm `11.13.0`; Bun `1.3.14` via `npx`                                                                           |
| Intended package manager | Bun, established by `bun.lock` and `bunfig.toml`                                                                                 |
| Lock integrity           | SHA-256 unchanged across `bun install --frozen-lockfile`                                                                         |
| Git line endings         | System `core.autocrlf=true`; 126 tracked text files are LF in the index and CRLF in the worktree; no `.gitattributes`            |

### Environment and secret review

The tracked `.env` contains six non-empty values under these names: `SUPABASE_PROJECT_ID`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_SUPABASE_URL`. Values were not printed. Source/configuration also refers to `SUPABASE_SERVICE_ROLE_KEY`; example comments mention `DATABASE_URL`, `STRIPE_SECRET_KEY`, and `VITE_FOO`.

A redacted scan of the current tree and all 213 reachable commits found committed Supabase project identifiers/URLs and publishable keys in two historical `.env` blobs. It found no service-role assignment, private-key marker, secret-key assignment, or JWT-like token. Publishable keys and project URLs are designed for browser use, but checking them into `.env` exposes project identity and encourages unsafe credential handling. Replace the tracked file with a documented template in the stabilization phase and rotate any credential whose classification is uncertain. `gitleaks` was not installed, so this was a targeted pattern/history scan rather than a complete secret-scanner attestation.

## Verification baseline

| Check                           | Result    | Failures                                               | Warnings/notes                                                                                                                                                                                   |
| ------------------------------- | --------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun install --frozen-lockfile` | Pass      | None                                                   | 502 packages; lock hash unchanged                                                                                                                                                                |
| `bun run lint`                  | Fail      | 14,236 errors across 97 files                          | 14,229 are Prettier CRLF errors; 7 non-format ESLint errors remain. Also 26 warnings: 11 React Refresh, 9 hook dependencies, 6 unused disables.                                                  |
| `bunx tsc --noEmit`             | Fail      | Three `TS2322` route-search errors                     | `src/routes/_authenticated/dashboard.tsx:119,170`; `inventory.tsx:137`                                                                                                                           |
| `bun run build`                 | Pass      | None                                                   | 2,301 modules. Large client assets include a 23.9 MB ONNX/WASM binary and roughly 395–400 KB image-processing chunks. Module-directive/chunk warnings are emitted. The build does not typecheck. |
| Test discovery                  | Fail/none | No test files and no test script                       | `bun test` exits 1 with “No tests found”                                                                                                                                                         |
| `bun audit`                     | Fail      | 32 advisories: 1 critical, 14 high, 13 moderate, 4 low | Critical `seroval@1.5.2` is in the TanStack production graph; additional TanStack Start, Undici, protobufjs, Vite, PostCSS, and tooling advisories exist. Reachability was not exploit-tested.   |

### Post-containment verification — 2026-08-04

| Check                                       | Result | Notes                                                                                                                                                         |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx bun install --frozen-lockfile`         | Pass   | 519 installs across 610 packages checked; no changes                                                                                                          |
| Migration chain and `npm run test:security` | Pass   | All repository migrations applied to disposable PostgreSQL 17; expanded authorization, anti-bypass, Storage-path, RPC, and column-privilege assertions passed |
| `npm run lint`                              | Pass   | Zero errors; the 26 pre-existing warnings remain visible                                                                                                      |
| `npm run typecheck`                         | Pass   | The three TanStack Router search errors are resolved without suppression                                                                                      |
| `npm run build`                             | Pass   | Client and SSR production builds complete; existing module-directive and large-chunk warnings remain                                                          |
| `git diff --check`                          | Pass   | No whitespace errors                                                                                                                                          |
| `npx bun audit`                             | Fail   | Still 32 advisories: 1 critical, 14 high, 13 moderate, 4 low; no automatic upgrades applied                                                                   |

Native `supabase test db` was not run because Docker is unavailable. The portable harness executes real PostgreSQL RLS, grants, helper functions, invitation functions, and Storage policy expressions; Supabase-local or staging verification remains a release gate.

## Current architecture

### Framework and rendering model

The app uses React 19, TanStack Start file routing, TanStack Query, and Vite through `@lovable.dev/vite-tanstack-config`. `src/server.ts` provides the SSR fetch handler; `src/start.ts` adds global server error normalization and auth-token attachment for server functions. `src/router.tsx` creates a QueryClient per router and enables scroll restoration. `src/routes/__root.tsx` supplies root providers and error/not-found boundaries.

Most business data is read and written directly by the browser Supabase client. RLS and Storage policies—not route visibility—are therefore the security boundary. Only user-list/invite/resend/delete operations use authenticated TanStack server functions and a server-only service-role client.

### Route and feature inventory

| Route                | Access               | Primary feature                                 |
| -------------------- | -------------------- | ----------------------------------------------- |
| `/`                  | Public               | Session-aware redirect                          |
| `/login`             | Public               | Sign-in and reset request                       |
| `/accept-invite`     | Public/session-bound | Invitation validation, password set, acceptance |
| `/reset-password`    | Recovery session     | Password update                                 |
| `/dashboard`         | Authenticated        | Owner platform view or dealership activity      |
| `/inventory`         | Authenticated        | Filtered inventory and thumbnails               |
| `/vehicles/new`      | Authenticated        | Vehicle creation and VIN scanning/decoding      |
| `/vehicles/$id`      | Authenticated        | Vehicle, media, documents, editors, delete      |
| `/vehicles/$id/edit` | Authenticated        | Vehicle editing                                 |
| `/overlays`          | Authenticated        | Overlay library                                 |
| `/backdrops`         | Authenticated        | Backdrop library                                |
| `/documents`         | Authenticated        | Reusable document library and bulk attachment   |
| `/export`            | Authenticated        | Bulk vehicle export selection                   |
| `/dealerships`       | Owner UI             | Dealership administration                       |
| `/users`             | Owner UI             | User/invitation administration                  |

`src/routes/_authenticated.tsx` redirects unauthenticated browser sessions after Auth context loads. It is a client guard, not server-route authorization. Owner-only navigation is also UI-level; server functions and RLS must independently enforce privileges.

### Database and storage architecture

The final migration sequence defines ten public tables:

- `dealerships`, `profiles`, `vehicles`, `photos`, and `overlay_templates`
- `documents` and the `vehicle_documents` join table
- `backdrops`, `impersonation_logs`, and `user_invitations`

RLS is enabled on every table in the migration source. Tenant policies generally compare `dealership_id` to `get_user_dealership(auth.uid())`, with an owner bypass. Photos inherit the vehicle tenant through `EXISTS`. A later policy restricts vehicle deletion to `dealer_admin` or `owner`.

Storage buckets are `vehicle-photos`, `overlays`, `backdrops`, `dealership-logos`, and `documents`. The first four are public; `documents` was migrated from public to private. Write policies validate a vehicle-derived path or dealership prefix. No migration establishes per-bucket file-size or MIME restrictions.

### Authentication and role model

Supabase email/password sessions are subscribed to in `src/hooks/use-auth.tsx`. The provider fetches `profiles` and then dealership status. `owner` is global; `dealer_admin` and `staff` are dealership-scoped. In checked-in policies, dealer-admin's only distinct data privilege is vehicle deletion; tenant staff otherwise share broad CRUD over vehicles, photos, documents, overlays, and backdrops.

The owner can select a dealership through an impersonation context. This does not change the JWT identity; owner RLS access remains global and the selected dealership is a UI/data-filtering context. Impersonation events are recorded in `impersonation_logs`.

### Photo-processing architecture

Uploads go directly from browser `File` objects to Supabase Storage. The guided workflow assigns one of eleven shot names; free upload accepts multiple files. Background removal runs in the browser with `@imgly/background-removal`, an in-memory two-job queue, and ONNX/WASM. It uploads a transparent PNG, updates the existing `photos` row, then deletes the original object. Overlay and backdrop editors use full-resolution browser canvases and can either create a new photo row or overwrite an existing photo.

There is no durable job runner, asset/version model, upload resume protocol, original preservation, or persistent undo history. Standard `.upload` is used rather than Supabase's resumable TUS path.

## Major workflow dependency map

| Workflow                 | Route/UI                                                     | Hooks/utilities                                            | Tables                                                 | Storage/external dependency            |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- |
| Auth and profile         | `login`, `_authenticated`, `accept-invite`, `reset-password` | `use-auth`, auth middleware/attacher                       | `profiles`, `dealerships`, `user_invitations`          | Supabase Auth                          |
| Owner dealership context | `dashboard`, `dealerships`, app navigation                   | `use-impersonation`, `OwnerDashboard`                      | `dealerships`, `profiles`, `impersonation_logs`        | `dealership-logos`                     |
| Vehicle CRUD/VIN         | `inventory`, `vehicles/new`, `$id`, `$id/edit`               | `VehicleForm`, `VinScanner`                                | `vehicles`                                             | Device camera; NHTSA vPIC API          |
| Guided/free photos       | `vehicles/$id`                                               | `VehiclePhotos`                                            | `vehicles`, `photos`                                   | `vehicle-photos`                       |
| Cutout                   | `vehicles/$id`                                               | `VehiclePhotos`, `cutout-queue`                            | `photos`                                               | `vehicle-photos`; IMG.LY ONNX/WASM     |
| Overlay/backdrop edit    | `vehicles/$id`, `overlays`, `backdrops`                      | `OverlayEditor`, `BackgroundEditor`                        | `photos`, `overlay_templates`, `backdrops`             | Three public media buckets; Canvas     |
| Documents                | `documents`, `vehicles/$id`                                  | `VehiclePhotos`, document modals                           | `documents`, `vehicle_documents`, `vehicles`           | Private `documents` bucket             |
| Export                   | `export`, `vehicles/$id`                                     | `VehicleExportModal`, `CustomExportModal`, `export-photos` | `vehicles`, `photos`, `vehicle_documents`, `documents` | Fetch, Canvas, JSZip, browser download |
| User administration      | `users`                                                      | `InviteUserModal`, `users.functions`                       | `profiles`, `user_invitations`, `dealerships`          | Supabase Auth admin/service role       |

## Critical user journeys

| #   | Journey                      | Success path                                                                                                            | Failure, authorization, mobile, and integrity observations                                                                                                                                           |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Login/logout                 | Password session redirects to dashboard; logout clears session.                                                         | Auth errors surface. Client route protection is secondary to RLS. Deactivation is ineffective (F-02). Mobile login controls are undersized.                                                          |
| 2   | Invitation acceptance        | Token details load, recovery/invite session is checked, password updates, and an RPC atomically assigns profile/invite. | Password changes before the acceptance RPC, so an RPC failure leaves a changed password and pending invite. Tokens are plaintext bearer secrets.                                                     |
| 3   | Password reset               | Recovery link/session permits password update and dashboard redirect.                                                   | Reset request intentionally hides account enumeration, but also reports success when delivery fails. Reset route accepts any existing signed-in session, not only an observed recovery event.        |
| 4   | Owner selects dealership     | Context filters owner views and logs impersonation.                                                                     | JWT stays globally privileged; accidental unfiltered owner queries remain possible. Context is client state, not least-privilege delegation.                                                         |
| 5   | Staff creates vehicle        | Form inserts with the user's dealership; RLS checks tenancy.                                                            | Manual validation allows duplicate/invalid VIN/stock, negative/outlier numeric data, and free-form statuses. No transaction issue for single row.                                                    |
| 6   | Mobile VIN scan              | `getUserMedia` prefers environment camera; torch, cleanup, vibration, and readable errors exist.                        | Modal lacks dialog/focus semantics and live status. No device matrix has run; low-memory behavior is unknown.                                                                                        |
| 7   | NHTSA decode                 | Valid 17-character scan calls vPIC and maps returned fields.                                                            | No timeout/abort, `response.ok`, or API `ErrorCode/ErrorText` handling. Manual VIN entry bypasses scanner validation.                                                                                |
| 8   | Guided capture               | Rear-camera file input uploads a named shot and enqueues eligible exterior cutout.                                      | Raw full-size file is uploaded; no MIME/content/size validation, orientation normalization, compression, HEIC conversion, or resume.                                                                 |
| 9   | Replace guided shot          | New row/object is created, then old same-shot item is deleted.                                                          | Not transactional or uniquely constrained; failure/concurrency can create duplicates, lose the expected shot, or orphan storage.                                                                     |
| 10  | Free multi-upload            | Files upload sequentially and create photo rows.                                                                        | Every file computes sort from stale component state and can receive the same order. No cutout is queued for free uploads. Mobile uploads are non-resumable.                                          |
| 11  | Automatic background removal | Exterior guided photo becomes a PNG; status becomes done or failed.                                                     | Browser-only queue disappears on refresh/suspension; pending can be permanent. Original is deleted, so there is no revert. Two full-resolution jobs plus 23.9 MB WASM are risky on phones.           |
| 12  | Backdrop editing             | Canvas composes cutout, backdrop, optional overlay, then uploads JPEG.                                                  | Overwrite deletes old object before DB update and can break the row. It leaves `is_cutout` true on a flattened JPEG. Undo exists only in memory.                                                     |
| 13  | Overlay application          | Canvas produces a JPEG as a new or replacement photo.                                                                   | Same delete-before-update/data-loss window and stale cutout flag. Cross-origin fetch/canvas and full-resolution memory errors are not recovered robustly.                                            |
| 14  | Photo deletion               | Storage object and photo row are removed.                                                                               | Storage response errors are not consistently checked; sequencing can leave an orphan or a DB row pointing at missing media.                                                                          |
| 15  | Reorder photos               | Up/down 44 px controls swap two sort values.                                                                            | Two independent updates are non-atomic; concurrency or a second-update failure produces duplicates or partial order. Keyboard alternative is a positive.                                             |
| 16  | Set main image               | Clears both media tables, then marks the selected item.                                                                 | Three statements can leave no main; concurrent selection can create one main photo plus one main document because uniqueness is per table.                                                           |
| 17  | Attach document              | A library document links to one or many vehicles.                                                                       | Join policy validates only the vehicle tenant, not the document tenant; a known foreign document UUID can be attached. Bulk rows all use order `9999`.                                               |
| 18  | Export photos                | Browser fetches media, converts JPEGs, builds ZIP, and downloads.                                                       | Private document URLs fail outside the one signed-preview path; failed fetches are silently omitted while success continues. Full-set in-memory ZIP can exhaust mobile memory; no manifest/checksum. |
| 19  | Edit vehicle                 | Existing data loads, VIN remains read-only, and row updates.                                                            | Same schema/validation gaps; error feedback is toast-only and inputs lack robust error association. RLS protects row tenancy.                                                                        |
| 20  | Delete vehicle               | Dealer-admin/owner can delete the DB row; cascades delete relational children.                                          | Storage objects are not removed by DB cascade, producing permanent orphans. No durable cleanup/outbox or deletion audit.                                                                             |

## Findings register

Each finding below is confirmed from source/migrations/build/runtime unless explicitly labeled **Unverified live**.

### F-01 — P0: any authenticated user can promote their own profile to owner

- **Status (2026-08-04): Remediated in the working tree; deployment pending.** Broad authenticated profile mutation is revoked, only `full_name` remains client-writable, administrative mutations moved to active-owner server functions, and negative policy tests cover self/other promotion and dealership reassignment.

- **Evidence:** Authenticated users receive table-wide `UPDATE` privilege and the profile update RLS policy checks only `id = auth.uid()` (or existing owner). It does not restrict `role`, `dealership_id`, `status`, or other columns. RLS restricts rows, not columns.
- **Files:** `supabase/migrations/20260528131823_...sql:74,114-115`.
- **User impact:** A staff account can update its own `role` to `owner`, after which owner-bypass policies expose every dealership and privileged UI/server paths.
- **Recommended solution:** Immediately revoke broad profile updates; grant safe columns only or expose a tightly scoped self-profile RPC. Make role, dealership, and status changes owner-only through audited server/database functions. Add negative RLS tests for every protected column.
- **Blocks new features:** **Yes; blocks all release and feature work.**

### F-02 — P0: user deactivation and dealership suspension do not revoke data access

- **Status (2026-08-04): Remediated in the working tree; deployment pending.** Private caller-derived helpers now require an active profile and active tenant subscription in every tenant-table and Storage write policy. Disposable tests retain valid JWT identity while proving deactivated and suspended users are denied.

- **Evidence:** `use-auth.tsx:55` omits `status` but casts it as present, so the deactivation branch at lines 61–65 cannot fire. Suspension is enforced only by a client sign-out. RLS helpers/policies do not require active profile or dealership status.
- **Files:** `src/hooks/use-auth.tsx:41-79`; `supabase/migrations/20260528131823_...sql:84-166`; status migrations.
- **User impact:** A removed employee or suspended dealership can continue using a valid token and direct Supabase calls. UI sign-out cannot be the authorization boundary.
- **Recommended solution:** Centralize active-membership checks in non-public, secure database helpers used by every tenant policy; revoke sessions when status changes; include status in client state only for UX. Test active, deactivated, suspended, expired-token, and refresh-token cases.
- **Blocks new features:** **Yes; blocks all release and feature work.**

### F-03 — P1: private document media is consumed as public URLs

- **Evidence:** A migration makes `documents` private. The document page creates one-hour signed previews, but upload persists `getPublicUrl`; vehicle detail, `VehiclePhotos`, and export consume stored `documents.image_url` directly.
- **Files:** `supabase/migrations/20260529191206_...sql:2,34-41`; `src/routes/_authenticated/documents.tsx:30-35,300-304`; `VehiclePhotos.tsx:99-133`; `vehicles.$id.tsx:38-51`; `lib/export-photos.ts`.
- **User impact:** Attached document images can be broken in vehicle galleries, main images, and ZIP exports.
- **Recommended solution:** Store bucket/path, not public URL; generate authenticated signed URLs through one media service, and refresh/expire them safely. Add gallery/export tests against a private bucket.
- **Blocks new features:** **Yes; blocks document/export release.**

### F-04 — P1: browser-only cutout jobs are not durable and originals are destroyed

- **Evidence:** `cutout-queue.ts` holds queue/inflight sets only in module memory, marks pending fire-and-forget, uploads PNG, replaces the row URL, and deletes the original. There is no recovery scan or asset version table.
- **Files:** `src/lib/cutout-queue.ts:19-127`; `src/components/VehiclePhotos.tsx`.
- **User impact:** Refresh, navigation, closure, or mobile suspension can strand `pending` forever. Users cannot revert cutouts, and processing failure after partial writes can orphan data.
- **Recommended solution:** Preserve immutable originals; create durable processing jobs and derived assets; process with a worker/Edge service, leases, retries, idempotency, heartbeats, and reconciliation. Make the UI poll/subscribe to job state.
- **Blocks new features:** **Yes; blocks dependable photo production.**

### F-05 — P1: editor overwrite can create data loss and corrupt image state

- **Evidence:** Overlay and backdrop editors upload the replacement, delete the old object, then update the database row. If the update fails, the row still references the deleted original. Flattened JPEG replacement does not reset `is_cutout`.
- **Files:** `src/components/OverlayEditor.tsx:126-155`; `BackgroundEditor.tsx:817-842`.
- **User impact:** An ordinary network/database failure can break a photo permanently; later editors may treat an opaque JPEG as a transparent cutout.
- **Recommended solution:** Use immutable asset versions and update the active reference before asynchronous old-asset cleanup; explicitly record derivative type and lineage. Provide durable revert/version history.
- **Blocks new features:** **Yes; blocks editor expansion.**

### F-06 — P1: photo ordering, main selection, and guided replacement are non-atomic

- **Evidence:** Multi-upload calls `maxSort()` against stale React state; reorder performs two independent updates; main selection clears two tables then sets one; guided replacement inserts then deletes. Unique indexes enforce one main separately per table, not across the combined gallery.
- **Files:** `src/components/VehiclePhotos.tsx:141-280`; `supabase/migrations/20260528153945_...sql`; `20260528185053_...sql`.
- **User impact:** Concurrent staff or partial network failures can produce duplicate order, duplicate/missing main images, and duplicate/missing guided slots.
- **Recommended solution:** Create transactional PostgreSQL functions for sort reservation/resequencing, guided-shot replacement metadata, and unified main selection. Consider one gallery-item model or a single vehicle main-item reference.
- **Blocks new features:** **Yes for collaborative/reliable media use.**

### F-07 — P1: vehicle deletion and partial media failures leak storage

- **Evidence:** Vehicle delete removes only the database row. Cascades cannot delete Storage objects. Upload and delete flows do not implement compensation/reconciliation consistently.
- **Files:** `src/routes/_authenticated/vehicles.$id.tsx:61-67`; `VehiclePhotos.tsx:143-224`; editor and cutout utilities.
- **User impact:** Deleted vehicles and partial failures accumulate billable, publicly retrievable orphan objects; failed sequencing can leave broken database URLs.
- **Recommended solution:** Add an asset ledger plus outbox/tombstone processed by a retrying worker. Reconcile DB references to Storage periodically; make upload compensation explicit and idempotent.
- **Blocks new features:** **Yes for production data retention/cost control.**

### F-08 — P1: dependency graph contains critical/high advisories

- **Evidence:** `bun audit` reports 32 advisories, including critical `seroval@1.5.2` through the TanStack production graph, vulnerable TanStack Start server-core versions, Undici, protobufjs, Vite, and PostCSS.
- **Files:** `bun.lock`, `package.json`.
- **User impact:** Potential server/client security exposure and an unauditable release baseline. Exact exploitability for DealerShot was not proven.
- **Recommended solution:** Upgrade the TanStack/Lovable-compatible set together, deduplicate skewed internals, upgrade transitive media/network dependencies, rerun build and journey tests, and document any accepted advisory with reachability evidence and expiry.
- **Blocks new features:** **Yes for release; dependency upgrades should follow F-01/F-02 containment.**

### F-09 — P1: no automated safety net; lint and typecheck fail

- **Status (2026-08-04): Partially remediated in the working tree.** LF policy, explicit typecheck/security/aggregate scripts, real PostgreSQL policy tests, the three route-search fixes, and the seven non-format lint fixes are present. CI and the broader browser/unit smoke suite remain open.

- **Evidence:** No test files/script; `bun test` finds none. TypeScript has three errors. Lint has 14,236 errors due mostly to CRLF plus seven real errors and 26 warnings. Production build does not run typecheck.
- **Files:** repository-wide; `dashboard.tsx:119,170`; `inventory.tsx:137`; Git config/no `.gitattributes`.
- **User impact:** Authorization, storage, concurrency, and UI regressions can reach production undetected; Windows contributors cannot use lint as a meaningful gate.
- **Recommended solution:** Pin LF in `.gitattributes`, normalize intentionally in a dedicated reviewed change, add `typecheck` and test scripts, then establish the smoke suite below as CI release gates.
- **Blocks new features:** **Yes after immediate P0 containment.**

### F-10 — P1: cross-tenant document attachment is not fully constrained

- **Status (2026-08-04): Remediated in the working tree; deployment pending.** Vehicle-document policies validate that both referenced rows share a dealership and that the caller has active membership. ID-substitution coverage is included in the disposable policy suite.

- **Evidence:** `vehicle_documents` insert/update policies check the vehicle tenant but do not assert that `document_id` belongs to the same dealership. Foreign-key validity alone does not enforce matching tenant ownership.
- **Files:** `supabase/migrations/20260528185024_...sql:42-61`.
- **User impact:** A user who learns another tenant's document UUID can create a cross-tenant relationship. Visibility may remain filtered, but integrity/confidentiality assumptions are violated.
- **Recommended solution:** Enforce same-dealership vehicle/document membership in `WITH CHECK` and preferably a transactional attach RPC; add adversarial ID-substitution tests.
- **Blocks new features:** **Yes for document workflows.**

### F-11 — P1: accessible modal and status behavior is incomplete

- **Evidence:** At 390×844 the forgot-password overlay had no `dialog`/`aria-modal`, focus stayed on the background trigger, Escape/focus trapping was absent, the close icon lacked an accessible name, and the modal email field lacked an associated label. Similar custom overlays are used across capture/edit/document flows. Processing statuses are not consistently live regions.
- **Files:** `src/routes/login.tsx`; `VinScanner.tsx`; `VehiclePhotos.tsx`; `OverlayEditor.tsx`; `BackgroundEditor.tsx`; custom modals.
- **User impact:** Keyboard and screen-reader users can lose context or be unable to operate critical workflows; this fails the requested WCAG AA production target.
- **Recommended solution:** Standardize on tested Radix Dialog/AlertDialog primitives, restore focus, lock/mark background inert, label every control, associate errors, and use `role=status`/`aria-live` for asynchronous work.
- **Blocks new features:** **Yes for production accessibility, not P0 containment.**

### F-12 — P2: input validation and database constraints are incomplete

- **Evidence:** Scanner VIN validation is not shared with manual input. The vehicle form permits duplicates and implausible/negative year, price, odometer, and cylinder values. NHTSA fetch has no abort/timeout, HTTP-status check, or API error-field handling. React Hook Form is installed but unused in product forms; Zod is used only selectively.
- **Files:** `src/components/VehicleForm.tsx`; `VinScanner.tsx`; NHTSA decode logic; base schema migration.
- **User impact:** Dirty inventory data, slow/hung decode UX, inconsistent validation, and downstream export/search errors.
- **Recommended solution:** Define shared Zod domain schemas, use React Hook Form for accessible field errors, add DB `CHECK`/unique constraints with explicit business rules, normalize VIN/stock case, and add timeout/retry/error parsing.
- **Blocks new features:** **Yes for import/integration work; otherwise after P1 reliability.**

### F-13 — P2: schema indexing, function exposure, and auditability need hardening

- **Status (2026-08-04): Partially remediated.** Authorization helpers moved to a non-exposed `private` schema with empty search paths and caller-derived identity; arbitrary-user public helper functions were removed, and tenant foreign-key indexes were added. Privileged mutation audit events remain future work.

- **Evidence:** Common tenant/FK/policy columns lack indexes. RLS repeatedly invokes `auth.uid()`/helpers without the recommended scalar subselect pattern. Public `SECURITY DEFINER` helpers accept arbitrary user IDs and use `search_path=public`; default function execution was not revoked. Several media-related FKs/checks are absent.
- **Files:** all migrations, especially `20260528131823_...sql:83-102`; documents/backdrops/impersonation migrations.
- **User impact:** Policy scans degrade with growth; helpers may disclose role/membership information; weak referential integrity increases orphan/corrupt states.
- **Recommended solution:** Put private helpers in a non-exposed schema with empty/qualified search paths and explicit grants; constrain caller identity; add indexes based on `EXPLAIN`; add missing FKs/checks without long blocking transactions.
- **Blocks new features:** **Partly—function exposure before release; performance/index work before scale.**

### F-14 — P2: mobile image intake and export exceed a safe reliability envelope

- **Evidence:** `accept="image/*"` sends raw originals via standard upload. There is no dimension/size/MIME validation, resize/compression, metadata stripping, deterministic EXIF orientation, HEIC conversion, or resume. Cutout/editor canvases use full resolution. Export fetches and holds all JPEG blobs and ZIP data in browser memory.
- **Files:** `VehiclePhotos.tsx`; `VinScanner.tsx`; `cutout-queue.ts`; editors; `export-photos.ts`.
- **User impact:** iPhone formats may fail; rotating/large images can be wrong or exhaust memory; weak connections restart; exports can omit media or crash.
- **Recommended solution:** Add a tested preprocessing pipeline (decode/orient/resize/compress/strip metadata), explicit HEIC policy, TUS/resumable upload, bounded concurrency, and server-side streaming/job export for large sets.
- **Blocks new features:** **Yes for a mobile-first production claim.**

### F-15 — P2: public media posture is broader than tenant RLS suggests

- **Status (2026-08-04): Mutation containment only.** Public reads were deliberately preserved to avoid breaking current URLs. Active tenant membership is now required for writes; private-original and derivative redesign remains Phase 3 work.

- **Evidence:** Vehicle photos, overlays, backdrops, and logos are public buckets with public read policies. Public bucket retrieval bypasses tenant read authorization by design. Documents alone are private.
- **Files:** Storage migrations, especially `20260529191206_...sql:25-31`.
- **User impact:** Anyone with a stable object URL can retrieve dealership media after logout or account removal; deleted DB authorization does not revoke access.
- **Recommended solution:** Classify each asset. Keep only intentionally public syndication derivatives public; make originals/work files private, use short-lived signed URLs or authenticated transforms, and define retention/cache invalidation.
- **Blocks new features:** **Requires product decision before production.**

### F-16 — P2: error/loading semantics can present failure as empty or success

- **Evidence:** Many Supabase reads consume `data` without checking `error`; password reset always shows sent; export catches per-file errors and still reports a completed ZIP. Auth loading ends before profile loading finishes. Root route errors are handled, but feature-level failures are inconsistent.
- **Files:** `use-auth.tsx:41-47`; dashboard/inventory/library routes; `login.tsx`; `export-photos.ts`.
- **User impact:** Users cannot distinguish no data from authorization/network failure; incomplete exports can be trusted incorrectly; role UI can flicker.
- **Recommended solution:** Introduce typed query/service adapters, explicit loading/empty/error states, retry policy, export manifest and failure summary, and auth state that resolves session plus profile atomically.
- **Blocks new features:** **No after P0/P1, but required for release quality.**

### F-17 — P2: UI is responsive but not yet a polished, accessible product system

- **Evidence:** Desktop and 390 px login layouts rendered without overflow; authenticated source uses many 44 px controls and photo reorder has buttons. Login inputs measured 38 px, primary action 40 px, and forgot-password target 16 px. There is no reduced-motion rule despite animated/pulsing states. Some forms use visual labels without reliable `htmlFor`/IDs and errors lack `aria-describedby`/`aria-invalid`.
- **Files:** `src/index.css`; login/reset/invite routes; `VehicleForm.tsx`; application navigation and media components.
- **User impact:** Mobile touch misses, motion discomfort, and incomplete screen-reader context. Visual hierarchy is consistent but generic card/shadow treatment limits product distinctiveness.
- **Recommended solution:** Establish 44×44 minimum interactive targets, explicit labels/errors, reduced-motion behavior, reusable page/dialog/feedback patterns, and a final device/assistive-technology QA pass.
- **Blocks new features:** **No after P1, but blocks WCAG AA sign-off.**

### F-18 — P2: production response lacks a complete browser-security header policy

- **Evidence:** A read-only `HEAD` request to `https://dealershot.lovable.app/login` returned 200 with HSTS, `Referrer-Policy: strict-origin-when-cross-origin`, and `X-Content-Type-Options: nosniff`. No HTTP `Content-Security-Policy`, `X-Frame-Options`/CSP `frame-ancestors`, or `Permissions-Policy` header was observed.
- **Files:** deployment/hosting configuration is not represented explicitly in the repository.
- **User impact:** The browser has less defense in depth against injected content, framing/clickjacking, and unnecessary capability access. Absence of a response header does not by itself prove exploitability.
- **Recommended solution:** Define and test a deployment-owned CSP (including `frame-ancestors`), Permissions Policy, framing policy, and report-only rollout that accommodates Supabase, NHTSA, image models/workers, and Lovable hosting.
- **Blocks new features:** **No after P0/P1, but blocks production security sign-off.**

### F-19 — P3: metadata, operational documentation, and domain polish are stale

- **Evidence:** Root metadata still contains generic/Lovable-era values and the former README described only the initial foundation. Runtime/engine versions and deployment headers are unpinned/undocumented.
- **Files:** `src/routes/__root.tsx`; former `README.md`; package/config files.
- **User impact:** Weak social/search presentation and operator ambiguity.
- **Recommended solution:** Add DealerShot metadata/assets, version policy, environment matrix, runbooks, and deployment ownership after stabilization.
- **Blocks new features:** **No.**

## Mobile, accessibility, performance, and UX assessment

Using the Impeccable 0–4 dimensions, the current technical UI score is **10/20 (acceptable prototype, not production-ready)**:

| Dimension               | Score | Rationale                                                                                                            |
| ----------------------- | ----: | -------------------------------------------------------------------------------------------------------------------- |
| Accessibility           |   1/4 | Critical custom-dialog focus/label/status gaps; reorder alternative is positive                                      |
| Performance             |   1/4 | 23.9 MB WASM, full-resolution canvases, browser ZIP, no input bounds                                                 |
| Theming                 |   3/4 | Consistent OKLCH/tokenized dark navy system; limited explicit mode/semantic validation                               |
| Responsive              |   3/4 | No observed login overflow at 390 px; rear-camera and responsive navigation intent; device matrix absent             |
| Anti-pattern compliance |   2/4 | Useful hierarchy/empty states, but generic card grids, oversized shadows, and inconsistent feedback/modal primitives |

Contrast was visually reasonable in the tested unauthenticated screen but was not exhaustively measured across authenticated states. No claim of WCAG AA conformance is made.

## Testing strategy

There is currently no automated testing architecture. Add layers in this order:

1. **Database/RLS tests:** disposable Supabase project, seeded owner/admin/staff/deactivated/foreign-tenant identities; assert allowed and denied CRUD for every table, protected profile column, function, and Storage path.
2. **Unit tests:** VIN normalization/validation, NHTSA mapping/error parsing, file/path validation, sort planning, export naming/manifest, and image-state transitions.
3. **React component tests:** form validation, dialog focus restoration, loading/error/empty states, guided-shot replacement, and accessible announcements using Testing Library plus axe.
4. **Integration tests:** Storage upload compensation, private signed URLs, durable job state/retry, editor version activation, transactional reorder/main selection, and export omissions.
5. **Playwright E2E:** desktop plus iPhone/Pixel viewports; login, invitation/reset, vehicle CRUD, capture/upload, edit, export, role boundaries, offline/throttled failures, and processing interruption.
6. **Observability tests:** structured error events, job metrics, stale-job alarms, Storage reconciliation, export completeness, and security-audit events—without logging secrets or image URLs.

### Smallest high-value smoke suite

1. Staff login reaches only their dealership; foreign dealership IDs return zero/denied.
2. Staff creates a valid vehicle; invalid/duplicate VIN and stock are rejected at UI and DB.
3. One guided and three free photos upload; failure compensation leaves no orphan; order is unique/deterministic.
4. Reorder and unified main selection remain correct under concurrent requests.
5. Private document attachment renders with signed access and cannot cross tenants.
6. Export includes the selected main/photo/document set, reports any failure, and validates a manifest.

The release gate should run formatting check, lint, typecheck, unit/component tests, local Supabase policy/storage tests, E2E smoke at desktop/mobile widths, build, and dependency/secret scans.

## Operations that should become transactional or durable

- Profile role/dealership/status administration
- Invitation acceptance and user lifecycle/session revocation
- Vehicle/document same-tenant attachment
- Guided-shot metadata replacement and sort reservation
- Gallery resequencing and unified main selection
- Asset-version activation after editor/cutout work
- Vehicle deletion tombstone plus asset-cleanup outbox
- Processing job claim/lease/complete/fail/retry/reconcile

PostgreSQL cannot transactionally delete Supabase Storage objects. Use DB state plus an idempotent outbox/worker and reconciliation rather than pretending the two systems share one transaction.

## Production-readiness verdict

**Verdict: NOT READY — 32/100.** Do not onboard production dealerships or resume feature expansion. First contain F-01 and F-02, prove tenant denial with automated policy tests, repair private document/media integrity, establish durable asset/job semantics, and make lint/typecheck/smoke tests mandatory. A successful Vite build is useful evidence but is not a release qualification.

### Prioritized recommendations

1. Freeze feature development and remediate profile escalation plus active-membership enforcement in a reviewed migration.
2. Build disposable multi-tenant RLS/Storage tests before touching other authorization code.
3. Repair private document access and replace destructive media mutation with immutable originals/derivatives.
4. Move cutout processing to durable jobs with idempotent workers and stale-job reconciliation.
5. Add transactional RPCs for gallery ordering/main/guided replacement/document attachment.
6. Normalize line endings, clear TypeScript/lint failures, and add the six-journey smoke suite.
7. Upgrade/adjudicate vulnerable dependencies without breaking Lovable/TanStack compatibility.
8. Finish mobile preprocessing/resume, accessibility primitives, observability, deployment headers, and runbooks.

## Confirmed versus remaining uncertainty

Confirmed findings were derived from `origin/main`, the complete migration sequence, a frozen install, static source tracing, local production build, and read-only desktop/mobile browser checks. The following remain uncertain:

- Whether the live Supabase database exactly matches checked-in migrations
- Whether production Auth redirect/session settings differ from local assumptions
- Live cross-tenant behavior and Storage policy behavior with seeded adversarial identities
- Real iOS HEIC/orientation/camera behavior and memory limits across supported devices
- Production cache rules, CSP implementation details, monitoring, backups, recovery, and alerting beyond the observed response headers
- Advisory exploit reachability after a compatible TanStack/Lovable dependency upgrade

Resolve these in a disposable staging environment; do not probe production by changing IDs or uploading media.

## Reference standards and advisories

- Supabase: [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security), [column-level privileges](https://supabase.com/docs/guides/database/postgres/column-level-security), and [database function security](https://supabase.com/docs/guides/database/functions)
- Supabase: [Storage access control](https://supabase.com/docs/guides/storage/security/access-control) and [public/private bucket fundamentals](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- GitHub advisories: [critical seroval deserialization](https://github.com/advisories/GHSA-mv8w-475r-vwqw), [TanStack Start server-function dispatch](https://github.com/advisories/GHSA-9m65-766c-r333), and [Vite Windows deny bypass](https://github.com/advisories/GHSA-fx2h-pf6j-xcff)
