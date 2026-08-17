# DealerShot NetLook-replacement foundation

This document describes the dealership-operational foundation introduced on `feature/netlook-replacement-foundation`. It is an additive extension of the existing P0 authorization, Phase 1 account/job foundation, and photo-workflow optimization. It is not a claim that an external inventory or publishing provider is connected.

## Capability status

| Area                 | Status                          | Current behavior                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-store domain   | Operational foundation          | Every store belongs to an organization. Existing stores are backfilled without changing their IDs or tenant relationships. Group and store role records are normalized.                                                                                             |
| Retail readiness     | Operational                     | Configurable rules evaluate VIN, stock number, price, media counts/labels, processing failures, review, and required documents. A cached per-vehicle result retains exact reasons.                                                                                  |
| Inventory health     | Operational                     | Dashboard metrics link to filtered inventory; inventory shows price, age, media totals, readiness, reasons, store, and photographer.                                                                                                                                |
| Vehicle workspace    | Operational foundation          | Overview, Media, Equipment, Pricing, Documents, Activity, and Publishing live in one workspace.                                                                                                                                                                     |
| Photo shoots         | Operational                     | Guided and bulk sessions are durable, row-locked, attributed, counted, timed, idempotently completed, and represented in activity/payout data.                                                                                                                      |
| Media lineage        | Operational compatibility layer | Every photo has one immutable original variant; explicit office edits append variants and select an approved variant. Existing public-bucket URLs remain the compatibility boundary.                                                                                |
| Selective processing | Operational rule selection      | Media is classified and capture always keeps the original. Store rules can choose keep, enhance, background replacement, merchandising, or manual review. Only explicit Customize loads IMG.LY. No worker image handler exists yet.                                 |
| Accounting           | Operational foundation          | Completed shoots can snapshot a versioned payout rule. Reports use durable rows, filters, totals, CSV, approval/payment state, and print layout. No external payroll integration exists.                                                                            |
| Documents            | Partially operational           | Versioned data snapshots and printable HTML exist for Window Sticker/vehicle sheet, Buyer’s Guide, Addendum, CPO sheet, and placard types. Buyer’s Guide legal/FTC validation and dealership-approved final artwork remain required. No stored PDF renderer exists. |
| Integrations         | Architectural foundation        | Provider-neutral TypeScript contracts and normalized connection/publication records exist. They remain explicitly `not_configured` until real dealership credentials and specifications are supplied.                                                               |

## Domain hierarchy

`organizations` represent dealer groups. `dealerships` represent stores/rooftops and retain all existing tenant IDs. A store has vehicles, media rules, readiness rules, document templates, payout rules, and integration connection records. Users retain the protected platform roles `owner`, `dealer_admin`, and `staff`; normalized store assignments add operational access:

- `store_manager`: inventory, media, documents, reports, and store settings;
- `photographer`: inventory read, capture, and own production reporting;
- `inventory_media`: inventory, media preparation, and documents;
- `accounting`: reports and payout-state management.

Platform Owner and Dealer Administrator behavior remains compatible. A Dealer Administrator can retain assignments to multiple stores. Database capabilities—not navigation visibility—are authoritative.

## Vehicle and specification model

The vehicle record now supports provider-independent source IDs, series, inventory type, certification, arrival date, multiple price concepts, merchandising copy, internal notes, readiness/publication states, assigned photographer, and import metadata. Structured equipment and warranty tables avoid duplicating fields on the core record. External identifiers remain separate from DealerShot UUIDs.

`VehicleDataProvider` is the boundary for future VIN/equipment/warranty suppliers. Existing public NHTSA decode behavior is an interim client utility, not a configured commercial vehicle-data integration.

## Retail readiness

Rules are rows, not hard-coded global requirements. Each rule has scope (`all`, `new`, `used`, or `certified`), severity, configuration, order, and enablement. The evaluator stores a status and structured reasons:

- `retail_ready` when no applicable requirement fails;
- `needs_attention` for incomplete merchandising work;
- `blocked` for blocking identity/document/data failures;
- `processing` when required media work is still running;
- `awaiting_review` when required review remains.

Vehicle, media, and generated-document changes refresh the cached result. The UI parses reason keys into actionable staff copy. New stores receive conservative defaults automatically; managers can later receive a dedicated rule editor without changing the evaluator.

## Photo-shoot and media lifecycle

The lot workflow is `Start Shoot -> capture -> raw upload -> checklist/progress -> Complete Photos`. Starting creates or resumes an in-progress row. Raw uploads are bounded and retryable; completion waits for the queue, refuses failed uploads, then records trusted actor/time/duration/counts in one row-locked database operation. Repeated completion is rejected.

Capture classification records exterior, interior, odometer, VIN, detail, document, and miscellaneous media without queuing image work. The immutable original lineage is created by a database trigger. Office Customize appends a cutout, corrected cutout, or customized variant through an authorized function; it never deletes or overwrites the only original.

Current compatibility limitation: public `vehicle-photos` URLs remain reachable as documented in the P0/photo-workflow work. Private immutable originals, signed delivery, checksums, retention, and lifecycle policies belong to a future Media Ledger migration.

## Processing and cost control

Store rules default exterior media to manual review and all other categories to `keep_original`. Normal capture does not import background-removal code and does not queue cutout, background, overlay, shadow, reflection, or enhancement work. IMG.LY remains lazy client-side tooling for an authorized office user who explicitly opens Customize. `MediaProcessor` and publication provider contracts isolate future worker/provider implementations from inventory logic.

## Employee production and payouts

Material work emits durable `activity_events`. Shoot completion copies the exact counts and timing onto the shoot, emits a business/audit event, and—when an active rule exists—creates one payout entry containing the rule ID, version, and immutable rule snapshot. Changing a later rule cannot rewrite historical payout reasoning.

The current report supports store/date/employee/status filters, line items, totals, CSV, and printer-friendly output. Authorized users can approve or mark entries paid. Manual adjustments and multi-step accounting approval are represented by the schema but need a dedicated adjustment UI before they are called operational.

## Documents and printing

Document generation takes a versioned snapshot of allowed vehicle, store, equipment, and warranty data. Used-only Window Sticker and Buyer’s Guide defaults do not apply to new inventory. Re-generation supersedes the prior active record without destroying history. Print CSS removes application chrome, uses letter dimensions, preserves table headers, and avoids splitting critical sections.

These are technical printable templates. Dealership counsel/compliance must approve Buyer’s Guide wording and warranty configuration before production use. A server-side PDF artifact renderer and stored file reference are future work.

## Integration boundaries

The repository defines `InventoryImportProvider`, `VehicleDataProvider`, `InventoryPublishingProvider`, `MediaPublishingProvider`, and `MediaProcessor`. Connection rows retain status and non-secret metadata; publication rows retain destination/external ID/status/error. No screen may label a provider connected unless an actual configured adapter reports that state. Secrets must remain in server-side secret storage, never JSON metadata or a `VITE_*` variable.

## Security and migration guarantees

- All new tenant tables have RLS and indexed organization/store/vehicle relationships.
- Browser-supplied store IDs are verified through active memberships and capabilities.
- Temporary-password/onboarding containment remains part of every membership decision.
- Security-definer functions use `search_path = ''` and narrow execution grants.
- Photographers cannot create vehicle inventory, edit specifications, generate controlled documents, prepare media variants, approve payouts, or cross tenants.
- The migrations are additive and backfill current records; they do not reset Auth, Storage, or business rows.
- The disposable PostgreSQL suite exercises real table grants, RLS, functions, cross-tenant isolation, and ordinary authenticated identities. Hosted Auth, PostgREST, and Storage HTTP behavior still require disposable Supabase acceptance testing.

## Future dealership API onboarding

1. Obtain written provider specifications, credentials, rate limits, field ownership, deletion semantics, and test endpoints.
2. Build a server-only adapter behind the matching provider contract.
3. Map external IDs to DealerShot IDs without changing tenant keys.
4. Define reconciliation and idempotency behavior before enabling writes.
5. Validate imports/publications in a disposable store and expose honest per-destination status.
6. Enable the connection only after tenant, audit, error, retry, and secret-handling review.

## Next internal boundaries

The highest-value follow-up is hosted operational acceptance and configuration UI for readiness/photo/document/payout rules using representative dealership inventory. The later Media Ledger should then move immutable originals to private storage and implement signed variants, checksums, thumbnails, durable renderer jobs, and publication-safe asset lifecycle. Full offline background sync, 360 capture, production VIN data, payroll export integrations, and website syndication remain separate work.
