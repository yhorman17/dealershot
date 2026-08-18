import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const listRoute = read("src/routes/_authenticated/bulk-photos.tsx");
const workspaceRoute = read("src/routes/_authenticated/bulk-photos.$id.tsx");
const vehicleForm = read("src/components/VehicleForm.tsx");
const migration = read(
  "supabase/migrations/20260818193308_fix_bulk_capture_resume_cancel_duplicates.sql",
);

test("Bulk child routes render through the parent and reconstruct durable workflow state", () => {
  assert.match(listRoute, /pathname\.startsWith\("\/bulk-photos\/"\) \? <Outlet \/>/);
  assert.match(listRoute, /to="\/bulk-photos\/\$id"/);
  assert.match(workspaceRoute, /\.eq\("id", id\)/);
  assert.match(workspaceRoute, /workflow_stage/);
  assert.match(workspaceRoute, /Date\.parse\(session\.started_at\)/);
  assert.match(workspaceRoute, /capture_ended_at \? Date\.parse/);
  assert.match(workspaceRoute, /resolveAuthorizedMediaUrls/);
  assert.match(workspaceRoute, /setCameraOpen\(true\)/);
});

test("canceled workflows are confirmed, hidden from Active, and cannot reopen", () => {
  assert.match(listRoute, /Cancel this capture workflow\?/);
  assert.match(listRoute, /cancel_bulk_capture_workflow/);
  assert.match(listRoute, /\.neq\("status", "canceled"\)/);
  assert.match(listRoute, /The vehicle[\s\S]*and any photos already uploaded will be kept/);
  assert.match(workspaceRoute, /status === "canceled"/);
  assert.match(workspaceRoute, /can no longer be resumed/);
  assert.match(migration, /status='canceled'/);
  assert.match(migration, /capture_ended_at=coalesce\(capture_ended_at,now\(\)\)/);
  assert.match(migration, /bulk_photo_session\.canceled/);
  assert.doesNotMatch(migration, /DELETE FROM public\.bulk_photo_items/);
  assert.doesNotMatch(migration, /DELETE FROM public\.vehicles/);
  assert.doesNotMatch(migration, /create_shoot_payout/);
});

test("Bulk start is idempotent and database-enforced for a store VIN or vehicle", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /photo_capture_sessions_one_active_bulk_vin_idx/);
  assert.match(migration, /photo_capture_sessions_one_active_bulk_vehicle_idx/);
  assert.match(migration, /IF target\.id IS NOT NULL THEN RETURN target/);
  assert.match(migration, /ON CONFLICT DO NOTHING RETURNING \* INTO target/);
  assert.match(migration, /session\.workflow_stage IN \('capture','review','processing'\)/);
  assert.match(vehicleForm, /savingRef\.current/);
  assert.match(vehicleForm, /if \(savingRef\.current\) return/);
});

test("cancel RPC checks active tenant membership and capture/media capabilities", () => {
  assert.match(migration, /current_user_has_active_membership\(target\.dealership_id\)/);
  assert.match(migration, /current_user_has_store_capability\(target\.dealership_id,'media'\)/);
  assert.match(migration, /target\.created_by=actor_id[\s\S]*'capture'/);
  assert.match(migration, /RAISE EXCEPTION 'Bulk Capture workflow is unavailable.'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.cancel_bulk_capture_workflow/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.cancel_bulk_capture_workflow/);
});

test("only empty hosted duplicates are reconciled and the earliest stays canonical", () => {
  assert.match(migration, /sum\(item_count \+ photo_count \+ asset_count\) = 0/);
  assert.match(migration, /ORDER BY session\.started_at, session\.id/);
  assert.match(migration, /WHERE active\.sequence > 1/);
  assert.match(migration, /redundant empty Bulk Capture workflow/);
});
