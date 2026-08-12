# DealerShot photo workflow optimization

This pass separates fast, durable lot capture from office photo preparation. It is intentionally smaller than the future Media Ledger: it does not add storage quotas, archival lifecycle, payroll, syndication, or a new processing service.

## Capture contract

- Guided and Bulk Photos create or resume a tenant-scoped `photo_capture_sessions` row.
- Each original uploads immediately. A bounded two-upload queue lets the photographer continue while prior files finish and releases each full-resolution browser `File` after success.
- Capture never imports or invokes `@imgly/background-removal`, applies a backdrop, renders an overlay, or creates shadow/reflection output.
- Failed uploads retain their local payload and expose Retry Uploads. Complete Photos waits for queued work and refuses completion while a failure remains.
- Completion is a trusted RPC transition. It records `completed_by`, `completed_at`, a durable item count, and one audit event without storing pixel or mask data.

Below the existing `md` breakpoint (768 px), the vehicle capture/gallery UI hides office preparation, main-selection, and ordering controls. It retains capture, retake, shot navigation, progress, upload feedback, deletion, and completion.

## Bulk Photos

`photo_capture_sessions.mode = 'bulk'` supports a 17-character normalized VIN with an optional existing vehicle. `bulk_photo_items` points to each original Storage object. Staff may capture and complete their own active-dealership packages; assigned Dealer Admins and Owner may review and prepare them.

Office users can assign standard shots, reorder, select a main image, remove unwanted photos, and associate the package. If the VIN is not yet inventory, DealerShot attempts NHTSA decoding and creates a lightweight vehicle for follow-up. Association creates normal `photos` rows that reference the existing object URLs; it does not upload or copy the physical files.

## Customize and Fix Cutout

Customize is lazy-loaded through a recoverable Radix dialog portal. Loading and initialization failure states have visible close controls, Escape behavior, focus containment, and automatic scroll-lock cleanup.

Background removal is an explicit desktop action. Only that action dynamically imports IMG.LY. The immutable `original_image_url` is protected by a database trigger. Cutout and customized derivatives receive separate URLs; save failure leaves the editor and previous database image intact.

Fix Cutout edits alpha only:

- Erase moves mask alpha toward transparent.
- Restore moves mask alpha toward opaque and reveals RGB pixels from the immutable original.
- Undo, redo, initial-mask reset, brush size/hardness, zoom, and pan are local preview state until Apply Mask and Save Changes.
- Coordinate mapping accounts for object-contain letterboxing, CSS pixels, zoom, pan, and image backing dimensions. High-DPI canvas density does not alter pointer mapping.

## Security and concurrency

New tables use RLS, narrow grants, active membership helpers, trusted `auth.uid()` completion metadata, and fixed-search-path security-definer functions. A trigger rejects a photo/capture-session relationship whose vehicle and dealership do not match. Storage mutation paths accept a validated vehicle UUID or authorized capture-session UUID; knowing a path is not authorization.

There is no global workflow lock. Completion and association lock only the target capture-session row. Multiple photographers and office users can work on different vehicles/packages concurrently.

## Compatibility boundary and future Media Ledger

This pass preserves current `vehicle-photos` public-read behavior and URL-shaped media model so it can ship safely on the Phase 1 foundation. The original is non-destructive within current photo-editing paths, but it is still stored in the existing public bucket rather than a future private immutable-original tier.

The Media Ledger phase should later provide private originals, derivative lineage/versioning, resumable or server-coordinated uploads, atomic ordering/main selection, durable processing jobs, garbage collection, retention, and migration away from public object URLs. Manual desktop cutout can then move from lazy client WASM to a worker without changing the capture-session completion contract.
