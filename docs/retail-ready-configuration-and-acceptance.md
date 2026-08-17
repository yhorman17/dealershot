# Retail Ready configuration and acceptance

This pass turns the NetLook-replacement foundation into store-configurable workflows. It does not connect a dealership inventory feed or publication destination.

## Store configuration

Authorized Owner, Dealer Administrator, and Store Manager accounts can configure a store from **Store settings**.

- **Retail Readiness** controls vehicle data, media, processing, and review checks. Saving calls a tenant-authorized database function and immediately re-evaluates that store’s vehicles.
- **Photography** owns the ordered shot list and the short-shoot completion policy. Guided sessions snapshot both when they start so an in-progress employee workflow does not change underneath them. Bulk intake remains unordered until office preparation.
- **Media Processing** exposes only operational modes. `Keep original` and `Manual review` are available; unsupported automation is not presented as connected.
- **Documents** separates new, used, and certified applicability. A document may be enabled without being required for Retail Ready.
- **Payout Rules** creates immutable, effective-dated versions. New versions deactivate the previous rule for the same task. Completed payouts keep their rule snapshot.

New stores receive conservative defaults: VIN, stock number, one photo, and failure-free processing checks; an exterior guided list; originals retained by default; and no enabled payout rule. Window Sticker and Buyer’s Guide defaults remain technical starting points, not dealership or legal approval.

## Capture and completeness

Raw originals upload as each photo is captured. The capture screen shows required exterior/interior progress and exact missing labels. **Complete Photos** waits for uploads and refuses failed uploads. A store can block short-shoot completion or allow it only after the photographer acknowledges the missing-shot warning. The completed session retains the missing-requirement snapshot for reports and future accounting review.

## Media integrity

Browser inserts are normalized to raw, unapproved, non-primary assets. Processed variants can only be committed through the protected media pathway. Vehicle and bulk-package ordering and primary-image changes lock their parent row and commit atomically through RPCs. Direct browser updates to protected media state are revoked.

## Documents

Generated records snapshot the vehicle, store, equipment, and warranty data. A source-data change marks the active version stale; regeneration creates a new version and preserves history. Browser printing remains the supported output in this pass. Stored PDF generation was deliberately deferred because the current runtime has no small, already-supported server PDF path.

The Buyer’s Guide is a technical template only. Dealership counsel or the responsible compliance team must approve wording, selections, translations, and the physical printing workflow before production use.

## Accounting

Production & Payouts derives from durable shoot and payout rows. Payouts must move from Pending to Approved to Paid; Paid and Void are terminal. Authorized management/accounting users can record a reasoned manual correction, bonus, or deduction. The actor, amount, employee, date, and reason are audited.

Operational report views cover Daily Activity, No Photos, Short Shoot, Processing, and Inventory Attention. Inventory age is calculated from the arrival date and displayed in 0–15, 16–30, 31–60, 61–90, and 90+ day bands.

## Hosted acceptance safety

Before applying the migrations remotely:

1. Verify the target project is the approved DealerShot testing project and not a dealership production database.
2. Capture the remote migration list and schema backup/export.
3. Apply the complete migration chain in timestamp order. Never edit a migration already applied elsewhere; add a corrective migration.
4. Create test identities through normal Auth onboarding and store assignments. Never put temporary credentials in Git.
5. Use generic vehicles and media with no consumer or customer information.
6. Execute the role, used/new/CPO, processing failure, upload, payout, document, and two-store isolation scenarios.
7. Record browser/device limitations honestly. Responsive emulation is not real iOS Safari or Android Chrome acceptance.
8. Remove staging-only identities and fixtures when acceptance ends, preserving any audit evidence required by the test plan.

## External dependencies

Inventory import, vehicle-data/VIN enrichment, dealership website/media publication, dealership-approved document art/legal text, and actual compensation rules remain external inputs. No adapter should show `Connected` until a real provider and credentials are configured.
