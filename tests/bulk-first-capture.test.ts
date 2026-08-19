import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  captureMethodIsEnabled,
  parseCaptureMethodConfiguration,
} from "../src/lib/capture-methods.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const migration = read("supabase/migrations/20260818190335_bulk_first_capture_workflow.sql");

test("Bulk is the safe default and disabled defaults fall back predictably", () => {
  assert.deepEqual(parseCaptureMethodConfiguration({}), {
    bulkEnabled: true,
    guidedEnabled: true,
    defaultMethod: "bulk",
  });
  const guidedOnly = parseCaptureMethodConfiguration({
    bulk_enabled: false,
    guided_enabled: true,
    default_method: "bulk",
  });
  assert.equal(guidedOnly.defaultMethod, "guided");
  assert.equal(captureMethodIsEnabled(guidedOnly, "bulk"), false);
  assert.equal(captureMethodIsEnabled(guidedOnly, "guided"), true);
});

test("store settings enforce one enabled method and an enabled default", () => {
  assert.match(migration, /bulk_capture_enabled boolean NOT NULL DEFAULT true/);
  assert.match(migration, /default_capture_method text NOT NULL DEFAULT 'bulk'/);
  assert.match(migration, /bulk_capture_enabled OR guided_capture_enabled/);
  assert.match(migration, /At least one capture method must remain enabled/);
  assert.match(migration, /The default capture method must be enabled/);
  const settings = read("src/routes/_authenticated/settings.tsx");
  assert.match(settings, /title="Capture methods"/);
  assert.match(settings, /save_capture_method_configuration/);
  assert.match(settings, /Default capture method/);
});

test("Add Vehicle starts the configured method without returning to Inventory", () => {
  const route = read("src/routes/_authenticated/vehicles.new.tsx");
  assert.match(route, /get_capture_method_configuration/);
  assert.match(route, /parseCaptureMethodConfiguration/);
  assert.match(route, /start_photo_capture_session/);
  assert.match(route, /to: "\/bulk-photos\/\$id"/);
  assert.match(route, /search: \{ capture: "guided" \}/);
  assert.match(route, /submitLabel=/);
});

test("capture timing stops at photographer intent and feeds durable completion", () => {
  assert.match(migration, /capture_ended_at timestamptz/);
  assert.match(migration, /mark_bulk_capture_ended/);
  assert.match(
    migration,
    /duration_seconds=greatest\(0,extract\(epoch FROM \(coalesce\(capture_ended_at,now\(\)\)-started_at\)\)/,
  );
  const route = read("src/routes/_authenticated/bulk-photos.$id.tsx");
  assert.match(route, /mark_bulk_capture_ended/);
  assert.match(route, /await uploadQueue\.waitForIdle\(\)/);
});

test("consecutive camera and bounded upload state are mobile-first", () => {
  const camera = read("src/components/BulkCamera.tsx");
  const route = read("src/routes/_authenticated/bulk-photos.$id.tsx");
  assert.match(camera, /navigator\.mediaDevices[\s\S]*getUserMedia/);
  assert.match(camera, /facingMode: \{ ideal: facingMode \}/);
  assert.match(camera, /playsInline/);
  assert.match(camera, /env\(safe-area-inset-bottom\)/);
  assert.match(camera, /canvas\.toBlob/);
  assert.match(camera, /multiple/);
  assert.match(route, /createUploadQueue<BulkUpload>/);
  assert.match(route, /\{ concurrency: 2 \}/);
  assert.match(route, /acceptedCount[\s\S]*pending[\s\S]*failed/);
});

test("review supports safe removal, replacement, ordering and main image", () => {
  const route = read("src/routes/_authenticated/bulk-photos.$id.tsx");
  const sharedReview = read("src/components/VehiclePhotoReviewStages.tsx");
  assert.match(route, /replaceItemId/);
  assert.match(route, /await uploadPrivateOriginal/);
  assert.match(route, /if \(replaced\) await archivePrivateMedia/);
  assert.match(route, /reorder_bulk_photo_items/);
  assert.match(route, /set_bulk_primary_item/);
  assert.match(sharedReview, /Retake \/ replace/);
});

test("processing selection queues durable work and never blocks the next vehicle", () => {
  const route = read("src/routes/_authenticated/bulk-photos.$id.tsx");
  const sharedReview = read("src/components/VehiclePhotoReviewStages.tsx");
  const worker = read("worker/media.ts");
  assert.match(sharedReview, /Select exterior/);
  assert.match(route, /queue_bulk_background_removal/);
  assert.match(route, /complete_bulk_capture_workflow/);
  assert.match(route, /Yes, next vehicle/);
  assert.match(migration, /'media\.background\.remove'/);
  assert.match(worker, /"media\.background\.remove": \(job\) => removeMediaBackground/);
  assert.match(worker, /await Promise\.all\(\[/);
  assert.match(worker, /import\("onnxruntime-node"\)/);
  assert.match(worker, /BACKGROUND_REMOVAL_MODEL_KEY = "\/models\/isnet_quint8"/);
  assert.match(worker, /background_model_integrity_failed/);
  assert.match(worker, /createTransparentVehicleCutout\(original\)/);
});

test("capture method and cross-store authorization are server-enforced", () => {
  assert.match(migration, /private\.capture_method_enabled\(_dealership_id,_mode\)/);
  assert.match(migration, /current_user_has_store_capability\(_dealership_id,'capture'\)/);
  assert.match(migration, /vehicle_store_id IS DISTINCT FROM _dealership_id/);
  assert.match(migration, /REVOKE INSERT ON public\.photo_capture_sessions FROM authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.queue_bulk_background_removal/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.queue_bulk_background_removal/);
});

test("Guided Capture remains available only when enabled", () => {
  const photos = read("src/components/VehiclePhotos.tsx");
  const nav = read("src/components/AppNav.tsx");
  assert.match(photos, /captureMethods\.guidedEnabled/);
  assert.match(photos, /Guided Capture is disabled for this store/);
  assert.match(photos, /Start Guided/);
  assert.match(photos, /Start Bulk Capture/);
  assert.match(nav, /captureMethods\.bulkEnabled/);
});
