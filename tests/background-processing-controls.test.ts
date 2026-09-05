import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const migration = read(
  "supabase/migrations/20260819210739_background_processing_state_controls.sql",
);
const bulkMigration = read(
  "supabase/migrations/20260820130624_bulk_background_removal_controls.sql",
);
const groupedMigration = read(
  "supabase/migrations/20260905012459_grounding_v3_grouped_background_activity.sql",
);

test("durable background jobs synchronize every user-facing photo state", () => {
  assert.match(migration, /CREATE TRIGGER background_jobs_sync_photo_state/);
  assert.match(migration, /WHEN NEW\.status IN \('queued', 'retry_scheduled'\) THEN 'queued'/);
  assert.match(migration, /WHEN NEW\.status = 'running' THEN 'processing'/);
  assert.match(migration, /WHEN NEW\.status = 'succeeded' AND EXISTS \([\s\S]*?THEN 'completed'/);
  assert.match(migration, /WHEN NEW\.status = 'dead_letter' THEN 'failed'/);
  assert.match(migration, /THEN 'not_required'/);
  assert.match(migration, /WITH latest AS/);
  assert.match(migration, /job\.job_type = 'media\.background\.remove'/);
});

test("manual retry is authorized, bounded, idempotent, and preserves attempt history", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.retry_background_removal/);
  assert.match(migration, /current_user_has_store_capability\(media_store_id, 'media'\)/);
  assert.match(migration, /FOR UPDATE OF target/);
  assert.match(migration, /job\.status IN \('queued', 'retry_scheduled', 'running'\)/);
  assert.match(migration, /LEAST\(25, GREATEST\(max_attempts, attempt_count \+ 1\)\)/);
  assert.doesNotMatch(migration, /DELETE FROM private\.background_job_attempts/);
  assert.match(migration, /vehicle_media\.background_removal_retried/);
});

test("cancel is cooperative for running work and never removes immutable originals", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.cancel_background_removal/);
  assert.match(migration, /job\.status IN \('queued', 'retry_scheduled', 'dead_letter'\)/);
  assert.match(migration, /ELSIF job\.status = 'running'/);
  assert.match(migration, /cancel_requested_at = now\(\)/);
  assert.match(migration, /WHEN job\.cancel_requested_at IS NOT NULL THEN 'cancelled'/);
  assert.match(migration, /AND cancel_requested_at IS NULL/);
  assert.doesNotMatch(
    migration,
    /DELETE FROM public\.media_assets|DELETE FROM public\.media_variants/,
  );
});

test("activity projection exposes only safe action metadata", () => {
  assert.match(migration, /AS retryable/);
  assert.match(migration, /AS cancelable/);
  assert.match(migration, /AS cancel_requested/);
  assert.match(migration, /AS safe_failure_label/);
  assert.doesNotMatch(migration, /last_error_message AS|storage_path AS|payload AS/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.retry_background_removal/);
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.retry_background_removal\(uuid\) TO authenticated/,
  );
});

test("worker rechecks cancellation before Storage promotion and cleans the exact rejected output", () => {
  const worker = read("worker/media.ts");
  assert.match(worker, /Cancellation is cooperative/);
  assert.match(worker, /background_processing_cancelled/);
  assert.match(
    worker,
    /\.from\(PRIVATE_BUCKET\)[\s\S]*?\.remove\(prepared \? \[path, prepared\.path\] : \[path\]\)/,
  );
  assert.match(worker, /background_variant_finalize_failed/);
});

test("Retry All Failed is store-scoped, bounded, authorized, and idempotent", () => {
  assert.match(
    bulkMigration,
    /CREATE OR REPLACE FUNCTION public\.retry_failed_background_removals/,
  );
  assert.match(
    bulkMigration,
    /private\.current_user_has_store_capability\(_dealership_id, 'media'\)/,
  );
  assert.match(bulkMigration, /job\.dealership_id = _dealership_id/);
  assert.match(bulkMigration, /job\.status = 'dead_letter'/);
  assert.match(
    bulkMigration,
    /target\.failure_category IN \('model_rejection', 'resource_failure'\)[\s\S]*target\.deterministic_failure_count < 2/,
  );
  assert.match(bulkMigration, /public\.retry_background_removal\(target\.id\)/);
  assert.match(bulkMigration, /already_active_count/);
  assert.match(bulkMigration, /not_retryable_count/);
  assert.doesNotMatch(bulkMigration, /DELETE FROM private\.background_job_attempts/);
});

test("Cancel All only closes eligible background work and preserves completed media", () => {
  assert.match(bulkMigration, /CREATE OR REPLACE FUNCTION public\.cancel_background_removals/);
  assert.match(
    bulkMigration,
    /job\.status IN \('queued', 'retry_scheduled', 'running', 'dead_letter'\)/,
  );
  assert.match(bulkMigration, /public\.cancel_background_removal\(target\.id\)/);
  assert.match(bulkMigration, /completed_untouched_count/);
  assert.doesNotMatch(
    bulkMigration,
    /DELETE FROM public\.media_assets|DELETE FROM public\.media_variants|DELETE FROM public\.photos/,
  );
  assert.match(
    bulkMigration,
    /REVOKE ALL ON FUNCTION public\.cancel_background_removals\(uuid\)[\s\S]*GRANT EXECUTE ON FUNCTION public\.cancel_background_removals\(uuid\) TO authenticated/,
  );
});

test("vehicle-level grouped controls remain capability and tenant scoped", () => {
  assert.match(
    groupedMigration,
    /CREATE OR REPLACE FUNCTION public\.retry_failed_background_removals_for_vehicle/,
  );
  assert.match(
    groupedMigration,
    /CREATE OR REPLACE FUNCTION public\.cancel_background_removals_for_vehicle/,
  );
  assert.match(
    groupedMigration,
    /private\.current_user_has_store_capability\(_dealership_id, 'media'\)/,
  );
  assert.match(groupedMigration, /asset\.vehicle_id = _vehicle_id/);
  assert.match(groupedMigration, /WHERE id = _vehicle_id AND dealership_id = _dealership_id/);
  assert.match(groupedMigration, /public\.retry_background_removal\(target\.id\)/);
  assert.match(groupedMigration, /public\.cancel_background_removal\(target\.id\)/);
  assert.match(
    groupedMigration,
    /REVOKE ALL ON FUNCTION public\.retry_failed_background_removals_for_vehicle\(uuid, uuid\)[\s\S]*GRANT EXECUTE ON FUNCTION public\.retry_failed_background_removals_for_vehicle\(uuid, uuid\)[\s\S]*TO authenticated/,
  );
  assert.doesNotMatch(
    groupedMigration,
    /DELETE FROM public\.media_assets|DELETE FROM public\.media_variants|DELETE FROM public\.photos/,
  );
});
