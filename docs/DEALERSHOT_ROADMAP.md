# DealerShot Controlled Roadmap

**Source baseline:** [`DEALERSHOT_BASELINE_AUDIT.md`](DEALERSHOT_BASELINE_AUDIT.md), audited at `origin/main` commit `5c11faed0dc3d6cd3195b2121d760732286afb11` on 2026-08-04.

This roadmap stabilizes the current product before feature development resumes. Each phase should be a small, reviewable change with migration rollback/forward notes, Lovable compatibility checked, and no production data mutation until staging evidence is accepted. P0 containment may start immediately; later phases do not bypass incomplete security gates.

## Phase 1 — Baseline stabilization

**Branch status (2026-08-04): Partially complete.** LF policy, route-search typing, focused lint fixes, explicit verification scripts, and disposable authorization tests are implemented. Runtime pinning, tracked environment cleanup, CI, warning cleanup, and staging drift evidence remain open.

### Scope

- Add `.gitattributes` with an intentional LF policy and normalize text in a dedicated, reviewable commit.
- Pin supported Bun/Node versions and add `typecheck`, `test`, `test:unit`, and `check` scripts.
- Fix the three TanStack route-search TypeScript errors, seven non-format lint errors, and 26 warnings without blanket suppression.
- Replace the tracked `.env` with a value-free `.env.example`; document local/staging/production separation and rotate anything whose classification is uncertain.
- Add CI for frozen install, formatting check, lint, typecheck, tests, build, audit, and secret scan.
- Capture a live-schema drift report from a disposable/staging Supabase project.

### Dependencies

- Repository-owner agreement on runtime versions and line-ending policy
- A non-production Supabase project and CI secret store
- Lovable-generated file/lockfile compatibility check

### Acceptance criteria

- Fresh Windows and Linux clones stay clean after frozen install/build.
- Formatting, lint, typecheck, and build pass with zero hidden errors.
- CI fails on lockfile drift, committed secret patterns, type errors, or missing tests.
- No secret values are tracked; server-only variables are never exposed to Vite.
- Staging migration history matches the repository or drift is explicitly reconciled.

### Validation commands

```sh
bun install --frozen-lockfile
bunx prettier --check .
bun run lint
bun run typecheck
bun test
bun run build
bun audit
git diff --check
git status --short
```

### Out of scope

- Feature redesign, schema authorization changes, image-pipeline changes, and production deployment
- Silencing rules, weakening TypeScript, or accepting lockfile rewrites merely to make CI green

## Phase 2 — Security and tenant isolation

**Branch status (2026-08-04): P0 containment complete; deployment and broader Phase 2 work remain.** The protected-profile, active-membership, tenant-table, Storage-write, invitation, and cross-tenant attachment controls are implemented in migration `20260804051336_enforce_active_tenant_authorization.sql` with disposable PostgreSQL assertions. No live project was changed. Public media redesign, session revocation, privileged audit events, and dependency upgrades remain open.

### Scope

- Remove self-service access to protected `profiles` columns; expose explicitly safe self-update columns only.
- Enforce active profile and active dealership membership inside all tenant RLS/Storage authorization paths.
- Move authorization helpers out of the exposed public API schema, use qualified/empty search paths, restrict execution, and prevent arbitrary-user enumeration.
- Validate both vehicle and document tenant in attachment policies/RPCs.
- Review every table operation and Storage path for owner, dealer-admin, staff, deactivated, suspended, anonymous, and foreign-tenant identities.
- Decide which media derivatives are intentionally public; make originals/work files private.
- Harden invitation tokens, revocation, session termination, and privileged audit events.
- Upgrade/adjudicate critical/high production dependency advisories.

### Dependencies

- Phase 1 test/CI harness
- Disposable Supabase projects with seeded multi-tenant fixtures
- Product decisions for owner scope, media publicity, suspension semantics, and staff/admin permissions

### Acceptance criteria

- A staff user cannot change role, dealership, status, or any other protected profile field through REST, RPC, GraphQL, or browser SDK.
- Deactivated users and suspended dealerships are denied by database/Storage policies even with a previously valid token.
- Every foreign-tenant select/insert/update/delete and object-path substitution is denied.
- Owner-only server functions reject non-owner bearer tokens and never serialize the service-role key.
- Public media is limited to documented syndication assets; private originals require authenticated/signed access.
- Critical/high production advisories are upgraded or time-bounded with documented reachability and owner approval.

### Validation commands

```sh
supabase db reset
supabase test db
bun run test:rls
bun run test:storage
bun run test:security
bun audit
bun run check
```

Run equivalent negative requests with seeded owner/admin/staff/deactivated/foreign-tenant JWTs. Never use production identities for these tests.

### Out of scope

- New roles, SSO, billing, dealership integrations, and visual redesign
- Treating hidden navigation or client sign-out as authorization

## Phase 3 — Durable image pipeline

### Scope

- Introduce immutable asset records for original, normalized, cutout, overlay, backdrop, thumbnail, and export derivatives with lineage and active-version references.
- Preserve originals and make activation/revert explicit.
- Add durable processing jobs with claim leases, idempotency keys, bounded retries, heartbeats, failure reasons, and stale-job reconciliation.
- Run compute in a worker/Edge-compatible service rather than page memory; keep client processing only as an optional preview.
- Add a DB outbox/tombstone for Storage cleanup, periodic orphan reconciliation, retention, and auditable deletion.
- Store bucket/path rather than permanent public URLs; centralize signed access.

### Dependencies

- Phase 2 media classification and policy tests
- Chosen worker runtime, queue/cron mechanism, Storage budget, and privacy/retention policy
- Migration/backfill plan for existing `photos.image_url` and document URLs

### Acceptance criteria

- Refresh, browser close, duplicate delivery, worker crash, and retry never lose the original or strand a job indefinitely.
- Exactly one active derivative is selected while prior versions remain revertible according to retention policy.
- Every upload/derivative/delete is represented in the asset ledger; reconciliation reaches zero unexplained orphans.
- Private documents and photo originals render/export through time-bounded access.
- Job state and failure messages are observable without secrets or raw media URLs in logs.

### Validation commands

```sh
supabase db reset
bun run test:assets
bun run test:processing
bun run test:storage
bun run test:integration
bun run check
```

Include forced worker termination, duplicate job delivery, failed upload, failed DB activation, and cleanup retry cases.

### Out of scope

- New AI models, cosmetic editor redesign, dealer syndication, and destructive migration without rehearsed backfill/rollback

## Phase 4 — Mobile capture reliability

### Scope

- Define supported browser/device/file matrix, including iPhone HEIC/HEIF behavior.
- Build a bounded preprocessing pipeline: decode, EXIF orientation normalization, dimension cap, compression, metadata stripping, validated MIME/signature, and thumbnails.
- Use resumable TUS uploads with persisted progress, safe retry/cancel, connectivity feedback, and bounded concurrency.
- Preserve rear-camera preference, torch, permission guidance, and stream cleanup.
- Add low-memory fallbacks and avoid simultaneous full-resolution decode/canvas work.

### Dependencies

- Phase 3 asset/job model
- Product quality targets for pixels, JPEG/WebP quality, max bytes, and metadata policy
- Physical iOS/Android test devices or a documented device-lab service

### Acceptance criteria

- Supported portrait/landscape JPEG, PNG, and chosen HEIC path arrive correctly oriented and within size/dimension budgets.
- Interrupted uploads resume without duplicate asset rows or user re-selection.
- Permission denied, no camera, offline, quota, corrupt file, and memory pressure produce actionable recovery.
- Capture/upload remains usable at 320 px width and all primary touch targets are at least 44×44 CSS px.
- Ten representative vehicles complete capture on the lowest supported phone without crash or runaway memory.

### Validation commands

```sh
bun run test:media
bun run test:upload
bun run test:e2e:mobile
bun run test:performance:mobile
bun run check
```

### Out of scope

- Native iOS/Android apps, RAW photography, video, 360° capture, and unsupported legacy browsers

## Phase 5 — Photo editor architecture

### Scope

- Make overlay/backdrop/crop/adjust operations non-destructive recipes that produce versioned derivatives.
- Replace delete-before-update with atomic active-version switching and deferred cleanup.
- Separate semantic states (`original`, `cutout`, `flattened`, `composite`) from the legacy `is_cutout` boolean.
- Persist edit recipe/version history, provide revert, and constrain canvas/export dimensions.
- Move final high-resolution rendering to the durable processing service where appropriate; keep responsive previews client-side.
- Create transactional RPCs for guided-shot replacement, deterministic ordering, and unified main-image selection.

### Dependencies

- Phases 2–4, especially immutable assets, worker runtime, and mobile normalization
- Product decisions for edit history, default overlay/backdrop behavior, and main-item semantics

### Acceptance criteria

- Overwrite mode cannot leave a DB record pointing at a deleted object under any injected failure.
- Every edit can revert to the prior version/original within retention policy.
- Reordering and main selection are atomic under two concurrent users; exactly one combined gallery main exists.
- Duplicate guided slot and duplicate sort-order races are prevented or deterministically resolved.
- Preview and exported render match within documented tolerance.

### Validation commands

```sh
supabase db reset
bun run test:gallery-rpc
bun run test:editor
bun run test:editor:visual
bun run test:e2e:media
bun run check
```

### Out of scope

- Generative backgrounds, advanced masking/retouching, video, and a broad visual redesign

## Phase 6 — Testing and observability

### Scope

- Complete unit, React component, RLS, Storage, integration, and Playwright layers described in the audit.
- Establish the six-journey smoke suite: login/tenant denial, vehicle creation, guided/free upload, ordering, main selection, and complete export.
- Add desktop and mobile projects, network/offline fault injection, upload failure, processing interruption, and concurrency tests.
- Instrument structured client/server/job errors, request/job correlation, queue depth/age, failed exports, orphan reconciliation, and security events.
- Define alert owners, severity, retention, privacy redaction, runbooks, and release dashboards.

### Dependencies

- Stable contracts from Phases 2–5
- Test data factories and disposable Supabase lifecycle
- Selected error/metrics platform and privacy review

### Acceptance criteria

- Smoke suite is deterministic, parallel-safe, and required on every merge.
- RLS/Storage test matrices cover every role/table/bucket operation and known ID-substitution attack.
- Injected upload, DB, worker, NHTSA, and export failures are observable and recoverable.
- Alerts identify stuck jobs, policy-denial spikes, error-rate regressions, and reconciliation drift without leaking secrets/PII.
- CI duration/flakiness budgets and test ownership are documented.

### Validation commands

```sh
bun run test:unit
bun run test:component
bun run test:rls
bun run test:storage
bun run test:integration
bun run test:e2e
bun run test:e2e:mobile
bun run test:smoke
bun run check
```

### Out of scope

- Chasing vanity coverage percentages, logging raw credentials/media URLs, and production synthetic writes before safety review

## Phase 7 — UX and accessibility refinement

### Scope

- Standardize all modals on accessible dialog primitives with focus trap/restore, Escape, inert background, labels, and descriptions.
- Associate form labels, hints, errors, and async statuses; add live-region policy and validation summaries.
- Enforce 44×44 targets, visible focus, keyboard operation, reduced motion, contrast, and non-drag reorder controls.
- Standardize loading, empty, permission, offline, retry, partial-success, destructive confirmation, and success states.
- Refine information hierarchy and product identity without disrupting proven workflows.
- Test authenticated routes at 320/390/768/1280/1440 px and with keyboard/screen readers.

### Dependencies

- Stable workflows from Phases 2–6
- Supported-browser/accessibility target (WCAG 2.2 AA recommended)
- Representative dealership-user usability sessions

### Acceptance criteria

- Automated axe checks show no serious/critical violations in critical journeys.
- Login/capture/edit/attach/export/user-management are keyboard-completable with logical focus order and restored focus.
- Every input has a programmatic label and associated error; every long-running task announces state changes.
- 320 px layouts have no unintended horizontal overflow; targets and contrast meet the chosen standard.
- Reduced-motion users receive functionally equivalent, restrained behavior.

### Validation commands

```sh
bun run test:component:a11y
bun run test:e2e:a11y
bun run test:e2e:mobile
bun run test:visual
bun run check
```

Also perform manual keyboard, NVDA/VoiceOver, zoom, contrast, and physical-device review.

### Out of scope

- A wholesale rebrand, marketing-site rebuild, gamification, or animation-heavy interaction work

## Phase 8 — Production deployment readiness

### Scope

- Define environments, deploy ownership, protected branches, preview/staging/production promotion, and migration sequencing.
- Configure CSP, HSTS, framing/referrer/permissions policies, secure cookies, CORS, cache rules, source-map policy, and rate limiting.
- Establish backups, point-in-time recovery, migration rollback/roll-forward, Storage recovery, retention/deletion, and disaster-recovery drills.
- Set SLOs for auth, CRUD, uploads, processing, and exports; create alerts, on-call/runbooks, status communication, and support escalation.
- Load/memory/cost test representative dealership volumes; verify bundle budgets and CDN/media behavior.
- Complete dependency, secret, license, privacy, data-processing, and threat-model review.

### Dependencies

- All earlier phase acceptance gates
- Hosting/Supabase plans, domain/identity access, monitoring, privacy/legal decisions, and launch owner

### Acceptance criteria

- Staging promotion runs migrations and smoke tests automatically; production requires reviewed approval and recorded rollback point.
- Restore, rollback/roll-forward, worker outage, provider outage, credential rotation, and tenant incident drills meet documented RTO/RPO.
- No unresolved P0/P1; accepted P2s have owners/dates. Security headers and dependency/secret scans pass.
- Capacity tests meet agreed latency, memory, throughput, error-rate, and cost budgets.
- Launch checklist, runbooks, ownership, support, and monitoring dashboards are signed off.

### Validation commands

```sh
bun run check
bun run test:smoke:staging
bun run test:security
bun run test:performance
bun audit
curl -I https://staging.example.com
```

Run backup/restore and incident drills through documented provider procedures; do not simulate destructively in production.

### Out of scope

- Automatic production push from an unreviewed branch, launch with waived P0/P1 items, and undocumented manual migrations

## Phase 9 — Future dealership integrations

### Scope

- Validate business priority and contracts for DMS/inventory feeds, VIN/valuation providers, marketplaces, OEM/dealer websites, SSO, webhooks, and scheduled exports.
- Design a canonical integration model with per-dealership credentials, mapping/versioning, idempotency, rate limits, retries/dead letters, audit events, reconciliation, and consent.
- Prototype one read-only or sandbox integration behind a tenant-scoped feature flag.
- Define onboarding, support, data ownership, deletion, provider outage, and cost controls.

### Dependencies

- Production-readiness sign-off and stable asset/inventory contracts
- Named customer demand, provider sandbox/legal agreements, secrets management, and support ownership

### Acceptance criteria

- Threat model proves tenant-isolated credentials/data and least privilege.
- Duplicate/out-of-order webhooks and retries are idempotent; reconciliation detects drift.
- Sandbox pilot has complete audit trail, rate/cost limits, revocation, monitoring, and rollback.
- Integration failure cannot block core capture, inventory, or export workflows.
- Product, security, operations, and a pilot dealership sign off before general availability.

### Validation commands

```sh
bun run test:integration-provider
bun run test:webhooks
bun run test:tenant-isolation
bun run test:smoke
bun run check
```

### Out of scope

- Building multiple speculative providers, storing credentials in browser/local storage, bypassing provider sandboxes, and coupling core data integrity to an external API

## Feature-development restart gate

Feature development remains paused. It may resume only after the remaining Phase 1 and 2 gates are accepted, F-03 through F-10 have committed owners and sequencing, the smoke suite is enforced, and staging demonstrates tenant isolation. Media/editor expansion should wait for Phases 3–5. Production launch requires Phase 8 sign-off.
