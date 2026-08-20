import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  translateVehicleDeletionFailure,
  vehicleDeletionIsBlocked,
} from "../src/lib/vehicle-deletion.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("delete outcomes distinguish protected work, authorization, dependencies, and missing vehicles", () => {
  const active = translateVehicleDeletionFailure({
    code: "55000",
    message: "This vehicle has an active photo shoot or pending uploads.",
  });
  const processing = translateVehicleDeletionFailure({
    code: "55000",
    message: "This vehicle has media processing in progress.",
  });
  assert.equal(active.code, "active_capture");
  assert.equal(processing.code, "active_processing");
  assert.equal(vehicleDeletionIsBlocked(active.code), true);
  assert.equal(vehicleDeletionIsBlocked(processing.code), true);
  assert.equal(translateVehicleDeletionFailure({ code: "42501" }).code, "not_allowed");
  assert.equal(translateVehicleDeletionFailure({ code: "P0002" }).code, "not_found");
  assert.equal(
    translateVehicleDeletionFailure({ message: "foreign key constraint" }).code,
    "dependency_cleanup_failed",
  );
});

test("confirmed deletion always preserves a visible pending, blocked, failed, or success outcome", () => {
  const route = read("src/routes/_authenticated/vehicles.$id.tsx");
  assert.match(route, /Deleting securely…/);
  assert.match(route, /role="alert"/);
  assert.match(route, /Deletion is blocked/);
  assert.match(route, /Deletion failed/);
  assert.match(route, /toast\.success/);
  assert.match(route, /clearAuthorizedMediaCache\(\)/);
  assert.match(route, /navigate\(\{ to: "\/inventory", replace: true \}\)/);
});

test("vehicle Review is capability-gated and available from workspace and Inventory", () => {
  const route = read("src/routes/_authenticated/vehicles.$id_.review.tsx");
  const workspace = read("src/routes/_authenticated/vehicles.$id.tsx");
  const inventory = read("src/routes/_authenticated/inventory.tsx");
  const routeTree = read("src/routeTree.gen.ts");
  assert.match(route, /capabilities\?\.media === true/);
  assert.match(route, /Media review access required/);
  assert.match(route, /createFileRoute\("\/_authenticated\/vehicles\/\$id_\/review"\)/);
  assert.match(
    routeTree,
    /AuthenticatedVehiclesIdReviewRouteImport\.update\(\{[^}]*getParentRoute: \(\) => AuthenticatedRoute,[^}]*\} as any\)/,
  );
  assert.match(workspace, /to="\/vehicles\/\$id\/review"/);
  assert.equal(inventory.match(/to="\/vehicles\/\$id\/review"/g)?.length, 2);
  assert.match(inventory, /canReview && vehicle\.photo_count > 0/);
});

test("existing vehicle review reuses Bulk stages without creating capture production", () => {
  const route = read("src/routes/_authenticated/vehicles.$id_.review.tsx");
  const bulk = read("src/routes/_authenticated/bulk-photos.$id.tsx");
  assert.match(route, /VehiclePhotoReviewStage/);
  assert.match(route, /VehiclePhotoProcessingStage/);
  assert.match(bulk, /VehiclePhotoReviewStage/);
  assert.match(bulk, /VehiclePhotoProcessingStage/);
  assert.doesNotMatch(route, /start_photo_capture_session|mark_bulk_capture_ended/);
  assert.doesNotMatch(route, /payout/);
});

test("review replacement appends a private original before archiving the old gallery item", () => {
  const route = read("src/routes/_authenticated/vehicles.$id_.review.tsx");
  const upload = route.indexOf("await uploadPrivateOriginal");
  const archive = route.indexOf("await archivePrivateMedia(retakeItem.media_asset_id)");
  assert.ok(upload >= 0 && archive > upload);
  assert.match(route, /vehicleId: id/);
  assert.match(route, /sortOrder: retakeItem\.sort_order/);
});

test("existing photo processing is idempotent, authorized, and asynchronous", () => {
  const migration = read(
    "supabase/migrations/20260820020423_review_background_removal_requeue.sql",
  );
  const route = read("src/routes/_authenticated/vehicles.$id_.review.tsx");
  assert.match(migration, /current_user_has_store_capability\(target\.dealership_id, 'media'\)/);
  assert.match(migration, /private\.request_background_removal_job/);
  assert.match(migration, /variant_type IN \('cutout', 'corrected_cutout'\)/);
  assert.match(migration, /asset\.vehicle_id = target\.id/);
  assert.match(migration, /REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO authenticated/);
  assert.match(route, /queue_vehicle_background_removal/);
  assert.match(route, /describeBackgroundRemovalQueueResult/);
});

test("Review returns to the route that launched it", () => {
  const route = read("src/routes/_authenticated/vehicles.$id_.review.tsx");
  assert.match(route, /from === "inventory"/);
  assert.match(route, /to: "\/inventory"/);
  assert.match(route, /to: "\/vehicles\/\$id"/);
  assert.doesNotMatch(route, /Photograph another vehicle/);
});
