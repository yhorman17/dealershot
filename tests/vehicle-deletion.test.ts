import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMediaJobHandlers } from "../worker/media.ts";
import type { BackgroundJob } from "../worker/runtime.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(
  path.join(root, "supabase/migrations/20260818130348_controlled_vehicle_deletion.sql"),
  "utf8",
);
const vehicleRoute = readFileSync(
  path.join(root, "src/routes/_authenticated/vehicles.$id.tsx"),
  "utf8",
);
const vehicleServerFunction = readFileSync(
  path.join(root, "src/lib/api/vehicles.functions.ts"),
  "utf8",
);

const operationId = "10000000-0000-4000-8000-000000000001";

function deletionJob(): BackgroundJob {
  return {
    job_id: "20000000-0000-4000-8000-000000000001",
    job_type: "vehicle.storage.cleanup",
    payload: { operation_id: operationId },
    dealership_id: "30000000-0000-4000-8000-000000000001",
    attempt: 1,
    max_attempts: 10,
    trace_id: "40000000-0000-4000-8000-000000000001",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function deletionClient(options: { failRemove?: boolean; succeeded?: boolean } = {}) {
  const removed: Array<{ bucket: string; paths: string[] }> = [];
  const rpcCalls: string[] = [];
  const manifest = [
    { bucket: "dealer-media-private", path: "stores/a/vehicles/v/media/m/original/a.jpg" },
    { bucket: "dealer-media-private", path: "stores/a/vehicles/v/media/m/preview/a.webp" },
    { bucket: "vehicle-photos", path: "v/legacy.jpg" },
  ];
  const client = {
    storage: {
      from(bucket: string) {
        return {
          async remove(paths: string[]) {
            removed.push({ bucket, paths });
            return options.failRemove
              ? { data: null, error: { message: "storage unavailable" } }
              : { data: [], error: null };
          },
        };
      },
    },
    async rpc(name: string) {
      rpcCalls.push(name);
      if (name === "worker_get_vehicle_deletion_operation") {
        return {
          data: {
            operation_id: operationId,
            vehicle_id: "50000000-0000-4000-8000-000000000001",
            storage_status: options.succeeded ? "succeeded" : "queued",
            storage_manifest: manifest,
          },
          error: null,
        };
      }
      if (name === "worker_complete_vehicle_deletion_storage_cleanup") {
        return { data: true, error: null };
      }
      if (name === "worker_fail_vehicle_deletion_storage_cleanup") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  return { client, removed, rpcCalls };
}

test("vehicle deletion is a capability-checked RPC rather than a raw client delete", () => {
  assert.doesNotMatch(vehicleRoute, /\.from\("vehicles"\)\.delete\(\)/);
  assert.match(vehicleRoute, /deleteVehicle\(\{ data: \{ vehicle_id: id \} \}\)/);
  assert.match(vehicleRoute, /if \(deleting\) return/);
  assert.match(vehicleRoute, /disabled=\{deleting\}/);
  assert.match(vehicleServerFunction, /You do not have permission to delete this vehicle/);
  assert.match(vehicleServerFunction, /No partial database deletion occurred/);
});

test("deletion migration preserves history and avoids blanket cascade changes", () => {
  assert.match(migration, /CREATE TABLE private\.vehicle_deletion_operations/);
  assert.match(migration, /ALTER TABLE public\.payout_entries[\s\S]*ADD COLUMN vehicle_snapshot/);
  assert.match(migration, /status IN \('completed','prepared'\)/);
  assert.match(migration, /status = 'running'/);
  assert.match(migration, /status IN \('queued','retry_scheduled'\)/);
  assert.match(
    migration,
    /DELETE FROM public\.media_variants WHERE media_asset_id = ANY\(media_ids\)/,
  );
  assert.match(migration, /DELETE FROM public\.media_assets WHERE id = ANY\(media_ids\)/);
  assert.match(migration, /REVOKE DELETE ON public\.vehicles FROM authenticated/);
  assert.doesNotMatch(
    migration,
    /ALTER TABLE[\s\S]*media_assets_vehicle_id_fkey[\s\S]*ON DELETE CASCADE/,
  );
});

test("worker removes only exact manifest objects and finalizes the outbox", async () => {
  const fixture = deletionClient();
  const handlers = createMediaJobHandlers(fixture.client as never);
  const result = await handlers["vehicle.storage.cleanup"](deletionJob());
  assert.deepEqual(fixture.removed, [
    {
      bucket: "dealer-media-private",
      paths: [
        "stores/a/vehicles/v/media/m/original/a.jpg",
        "stores/a/vehicles/v/media/m/preview/a.webp",
      ],
    },
    { bucket: "vehicle-photos", paths: ["v/legacy.jpg"] },
  ]);
  assert.deepEqual(fixture.rpcCalls, [
    "worker_get_vehicle_deletion_operation",
    "worker_complete_vehicle_deletion_storage_cleanup",
  ]);
  assert.deepEqual(result, { operation_id: operationId, deleted_objects: 3 });
});

test("worker records a retryable durable failure without guessing at rollback", async () => {
  const fixture = deletionClient({ failRemove: true });
  const handlers = createMediaJobHandlers(fixture.client as never);
  await assert.rejects(
    handlers["vehicle.storage.cleanup"](deletionJob()),
    /vehicle_storage_delete_failed/,
  );
  assert.deepEqual(fixture.rpcCalls, [
    "worker_get_vehicle_deletion_operation",
    "worker_fail_vehicle_deletion_storage_cleanup",
  ]);
});

test("replayed cleanup is idempotent after Storage already succeeded", async () => {
  const fixture = deletionClient({ succeeded: true });
  const handlers = createMediaJobHandlers(fixture.client as never);
  const result = await handlers["vehicle.storage.cleanup"](deletionJob());
  assert.deepEqual(fixture.removed, []);
  assert.deepEqual(result, { already_clean: true, operation_id: operationId });
});
