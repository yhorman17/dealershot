# DealerShot private media ledger

DealerShot treats the original vehicle photo as private source truth. URLs are delivery artifacts; the durable identity is `media_assets.id` plus a private bucket/object reference.

## Data model

- `media_assets` is the logical asset ledger. It owns tenant, store, vehicle/session, uploader, classification, MIME, dimensions, byte size, SHA-256, original location, lifecycle, and migration state.
- `media_variants` is append-oriented lineage. One immutable `original` belongs to each ledger asset. `thumbnail`, `preview`, `cutout`, `corrected_cutout`, `customized`, `enhanced`, `dealer_render`, and future `published` rows reference their source variant.
- `photos.media_asset_id` and `bulk_photo_items.media_asset_id` connect operational workflows to the ledger. Compatibility URL columns contain non-routable `private-media://` locators for new data and are no longer the source of truth.
- `private.media_storage_migrations` records source, destination, checksum, state, errors, and completion. It is the resumable rollback map for hosted migration.
- Existing durable `private.background_jobs` runs copy/verification, thumbnail generation, and final legacy-bucket lockdown.

## Access and delivery

The browser requests media by `media_asset_id` and purpose: thumbnail, preview, original, editor, or download. An authenticated RPC resolves the object only after current active-account, capability, and store checks. The server—not browser code—then issues a short-lived signed URL.

- thumbnail/preview/download: 5 minutes
- original/editor: 15 minutes

Signed URLs are cached only in memory with a 30-second refresh margin and cleared on logout/account change. They are never stored in local storage or database rows. Previously issued URLs may remain usable until their short expiry; deactivation blocks every new URL request.

Accounting has no general media capability. Photographers can view thumbnails/previews only for their own authorized capture/session. Owner, Dealer Admin, Store Manager, and Inventory/Media roles use the existing media capability for office workflows.

## Trusted uploads

1. Authenticated client requests a scoped upload target for a vehicle or bulk session.
2. Server resolves the authorized store and creates a private, non-upsertable signed upload token under a server-generated path.
3. Client uploads the bytes directly to the private bucket.
4. Server downloads and validates the stored bytes, detects the image format, enforces 25 MB, extracts dimensions, and computes SHA-256.
5. A service-only RPC creates the ledger, photo/bulk row, immutable original variant, audit record, and thumbnail job.
6. Failure removes the unfinalized private object. Browser clients cannot directly insert photos, bulk items, protected variants, or overwrite originals.

Accepted photo inputs are JPEG, PNG, and WebP. Empty mobile MIME values may be inferred from a safe filename only for upload preparation; trusted finalization always validates the actual stored bytes. HEIC/HEIF is not yet supported.

## Derivatives and rendering

The worker creates two non-AI WebP delivery derivatives:

- 320 px inventory/gallery thumbnail, quality 78
- up-to-1280 px preview, quality 82

Both preserve aspect ratio, do not enlarge smaller inputs, and strip unnecessary metadata through re-encoding. Original bytes remain unchanged. Thumbnail failure is retryable and never destroys the source.

New vehicle uploads accept JPEG, PNG, and WebP only. Historical SVG staging fixtures are preserved byte-for-byte in the separate private `dealer-media-legacy-private` quarantine bucket with `application/octet-stream` delivery, then rasterized to WebP for normal display. SVG is not re-enabled as a browser upload type or served inline as a display original.

Rendering jobs use the existing durable queue states and leases: queued, running, retry scheduled, succeeded, failed/dead-letter. Each job has bounded attempts and a dedupe key. Expensive AI/background processing is not enqueued merely because an original is uploaded; dealership classification and processing rules remain separate.

## Hosted cutover order

The schema and queue migrations are intentionally separate:

1. Apply `20260817212030_production_media_ledger_private_pipeline.sql`.
2. Deploy the exact web/worker build that understands private media jobs.
3. Verify worker startup created `dealer-media-private` as private with MIME/size restrictions.
4. Apply `20260817214320_enqueue_private_media_migration_jobs.sql`.
5. If legacy variants retain only compatibility URLs, apply the additive `20260817225800_backfill_legacy_media_variant_paths.sql`; it normalizes paths, links the orphan inventory, and idempotently enqueues the same jobs.
6. If hosted legacy records include SVG fixtures, deploy the worker that supports quarantined legacy originals, then apply `20260817231500_preserve_legacy_svg_originals.sql` to reset only those failed jobs into the isolated private compatibility flow.
7. Monitor every migration record and job. Copy is verified by destination download, byte count, and SHA-256 before references change.
8. The low-priority lockdown job refuses to run while a referenced migration is pending or failed. Only then does it change `vehicle-photos` to private.
9. Verify authenticated delivery and anonymous/cross-store denial before declaring cutover complete.

This order prevents the old deployed worker from claiming and dead-lettering job types it does not understand.

## Rollback and recovery

Do not delete legacy objects during this pass. If a severe issue occurs before lockdown, the previous public bucket remains available while code can roll back. After lockdown, a controlled emergency rollback consists of:

1. Stop/disable media migration and lockdown jobs.
2. Query `private.media_storage_migrations` for the exact source/destination map and state.
3. Restore the previous application SHA.
4. Re-enable the legacy bucket temporarily only with an explicit incident decision, because this restores the known public-read privacy gap.
5. Reconcile database references using the recorded source bucket/path; never guess paths.

Copied private objects and legacy sources are retained during validation. Failed records preserve a safe error code and can be retried idempotently. Orphans are inventoried in `private.media_orphan_audit`; they are not deleted automatically.

## Retention and future publishing

User-facing Delete archives the ledger/photo relationship rather than erasing the original object. Full retention automation remains future work. Approved does not mean public. A later publisher can create or copy an explicit `published` derivative to a publication destination without exposing the immutable private original.
