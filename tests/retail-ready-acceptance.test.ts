import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("store configuration is persisted only through authorized RPCs", () => {
  const settings = read("src/routes/_authenticated/settings.tsx");
  const migration = read(
    "supabase/migrations/20260817140659_retail_ready_configuration_acceptance.sql",
  );

  for (const rpc of [
    "save_readiness_configuration",
    "save_photography_configuration",
    "save_media_processing_configuration",
    "save_document_requirements",
  ]) {
    assert.match(settings, new RegExp(`rpc\\("${rpc}"`));
    assert.match(migration, new RegExp(`FUNCTION public\\.${rpc}`));
  }
  assert.match(migration, /current_user_has_store_capability\(_dealership_id, 'settings'\)/);
  assert.match(migration, /configuration\.readiness_changed/);
  assert.match(migration, /configuration\.photography_changed/);
  assert.match(migration, /configuration\.media_processing_changed/);
  assert.match(migration, /configuration\.documents_changed/);
});

test("guided capture uses snapshotted store requirements and explicit completion policy", () => {
  const capture = read("src/components/VehiclePhotos.tsx");
  const migration = read(
    "supabase/migrations/20260817140659_retail_ready_configuration_acceptance.sql",
  );

  assert.match(capture, /from\("photo_shot_requirements"\)/);
  assert.match(capture, /missingGuidedShots/);
  assert.match(capture, /get_capture_session_completeness/);
  assert.match(capture, /Complete with missing shots/);
  assert.match(migration, /requirements_snapshot jsonb/);
  assert.match(migration, /completion_policy IN \('block', 'warn'\)/);
  assert.match(migration, /NEW\.mode = 'bulk'/);
  assert.match(migration, /Required photos are missing/);
});

test("vehicle and bulk ordering are transactionally serialized by privileged RPCs", () => {
  const vehiclePhotos = read("src/components/VehiclePhotos.tsx");
  const bulkWorkspace = read("src/routes/_authenticated/bulk-photos.$id.tsx");
  const migration = read(
    "supabase/migrations/20260817140659_retail_ready_configuration_acceptance.sql",
  );

  assert.match(vehiclePhotos, /rpc\("set_vehicle_primary_asset"/);
  assert.match(vehiclePhotos, /rpc\("reorder_vehicle_gallery"/);
  assert.match(bulkWorkspace, /rpc\("set_bulk_primary_item"/);
  assert.match(bulkWorkspace, /rpc\("reorder_bulk_photo_items"/);
  assert.match(migration, /WHERE id = _vehicle_id FOR UPDATE/);
  assert.match(migration, /WHERE id = _session_id FOR UPDATE/);
  assert.match(migration, /Gallery changed while it was being reordered/);
  assert.match(migration, /Paid and void payouts are immutable/);
});

test("document and payout history remain versioned and visibly stale", () => {
  const operations = read("src/components/VehicleOperationsPanel.tsx");
  const printRoute = read("src/routes/_authenticated/vehicles.$id.documents.$documentId.tsx");
  const migration = read(
    "supabase/migrations/20260817140659_retail_ready_configuration_acceptance.sql",
  );

  assert.match(operations, /View history/);
  assert.match(operations, /Regenerate/);
  assert.match(printRoute, /This version is outdated/);
  assert.match(printRoute, /requires final legal\/FTC validation/);
  assert.match(migration, /stale_at timestamptz/);
  assert.match(migration, /create_manual_payout_adjustment/);
  assert.match(migration, /coalesce\(max\(version\), 0\) \+ 1/);
});

test("operational reporting exposes all accepted manager views", () => {
  const reports = read("src/routes/_authenticated/reports.tsx");
  for (const label of [
    "Production & Payouts",
    "Daily Activity",
    "No Photos",
    "Short Shoot",
    "Processing",
    "Inventory Attention",
  ]) {
    assert.match(reports, new RegExp(label.replace("&", "&")));
  }
  assert.match(reports, /create_manual_payout_adjustment/);
  assert.match(reports, /inventoryAge/);
  assert.match(reports, /0–15/);
  assert.match(reports, /90\+/);
});
