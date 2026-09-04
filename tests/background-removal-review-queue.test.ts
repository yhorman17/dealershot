import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  describeBackgroundRemovalQueueResult,
  parseBackgroundRemovalQueueResult,
  queueableReviewPhotoIds,
  selectedMediaAssetIds,
} from "../src/lib/background-removal-queue.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const items = [
  { id: "photo-original", media_asset_id: "media-original", media_category: "exterior" },
  {
    id: "photo-failed",
    media_asset_id: "media-failed",
    media_category: "exterior",
    processing_state: "failed",
  },
  {
    id: "photo-draft",
    media_asset_id: "media-draft",
    media_category: "exterior",
    processing_state: "needs_review",
  },
  {
    id: "photo-queued",
    media_asset_id: "media-queued",
    media_category: "interior",
    processing_state: "queued",
  },
  {
    id: "photo-processing",
    media_asset_id: "media-processing",
    media_category: "exterior",
    processing_state: "processing",
  },
  {
    id: "photo-ready",
    media_asset_id: "media-ready",
    media_category: "exterior",
    processing_state: "ready",
  },
];

test("Review maps selected photo identities to their canonical Media Ledger asset identities", () => {
  assert.deepEqual(selectedMediaAssetIds(items, new Set(["photo-failed", "photo-original"])), [
    "media-original",
    "media-failed",
  ]);
});

test("Select All and Select Exterior include terminal work but exclude active/completed work", () => {
  assert.deepEqual(queueableReviewPhotoIds(items), [
    "photo-original",
    "photo-failed",
    "photo-draft",
  ]);
  assert.deepEqual(queueableReviewPhotoIds(items, true), [
    "photo-original",
    "photo-failed",
    "photo-draft",
  ]);
  assert.deepEqual(queueableReviewPhotoIds(items, false, true), [
    "photo-original",
    "photo-failed",
    "photo-draft",
    "photo-ready",
  ]);
});

test("structured queue results preserve per-item outcomes", () => {
  const parsed = parseBackgroundRemovalQueueResult({
    selected_count: 5,
    queued_count: 1,
    already_active_count: 1,
    already_completed_count: 1,
    needs_review_existing_count: 1,
    invalid_media_count: 0,
    failed_to_queue_count: 1,
    reprocessed_count: 1,
    skipped_count: 4,
    outcomes: [
      { media_asset_id: "media-failed", photo_id: "photo-failed", outcome: "queued" },
      { media_asset_id: "media-active", outcome: "already_active" },
      { media_asset_id: "media-complete", outcome: "already_completed" },
      { media_asset_id: "media-draft", outcome: "needs_review_existing" },
      { media_asset_id: "media-error", outcome: "failed_to_queue" },
    ],
  });
  assert.equal(parsed.outcomes.length, 5);
  assert.equal(parsed.queued_count, 1);
  assert.equal(parsed.failed_to_queue_count, 1);
  assert.equal(parsed.reprocessed_count, 1);
});

test("Review feedback distinguishes queued, active, completed, empty, and failed outcomes", () => {
  const base = parseBackgroundRemovalQueueResult(null);
  assert.match(describeBackgroundRemovalQueueResult(base).description, /No photos were selected/);

  assert.match(
    describeBackgroundRemovalQueueResult({
      ...base,
      selected_count: 3,
      queued_count: 2,
      already_active_count: 1,
    }).description,
    /2 queued · 1 already processing/,
  );
  assert.match(
    describeBackgroundRemovalQueueResult({
      ...base,
      selected_count: 2,
      already_active_count: 2,
      skipped_count: 2,
    }).title,
    /already processing/,
  );
  assert.match(
    describeBackgroundRemovalQueueResult({
      ...base,
      selected_count: 2,
      already_completed_count: 2,
      skipped_count: 2,
    }).description,
    /completed cutouts/,
  );
  assert.equal(
    describeBackgroundRemovalQueueResult({
      ...base,
      selected_count: 1,
      failed_to_queue_count: 1,
      skipped_count: 1,
    }).shouldLeaveReview,
    false,
  );
  assert.match(
    describeBackgroundRemovalQueueResult(
      {
        ...base,
        selected_count: 2,
        queued_count: 2,
        reprocessed_count: 2,
      },
      { explicitReprocess: true },
    ).description,
    /2 queued from original.*immutable original.*successful new cutout active/,
  );
});

test("database queueing uses terminal generations plus one-active-job enforcement", () => {
  const migration = read(
    "supabase/migrations/20260820020423_review_background_removal_requeue.sql",
  );
  assert.match(migration, /background_jobs_one_active_removal_per_media_idx/);
  assert.match(migration, /status IN \('queued', 'retry_scheduled', 'running'\)/);
  assert.match(migration, /:v1:request:/);
  assert.match(migration, /'reprocesses_job_id', previous_job\.id/);
  assert.match(migration, /'outcome', 'already_active'/);
  assert.match(migration, /'outcome', 'already_completed'/);
  assert.match(migration, /'outcome', 'needs_review_existing'/);
  assert.match(migration, /'outcome', 'invalid_media'/);
  assert.match(migration, /'outcome', 'failed_to_queue'/);
  assert.match(migration, /current_user_has_store_capability\(target\.dealership_id, 'media'\)/);
});

test("explicit Review reprocessing bypasses completed-cutout skip without weakening passive dedupe", () => {
  const migration = read(
    "supabase/migrations/20260904183343_explicit_vehicle_review_reprocess.sql",
  );
  assert.match(
    migration,
    /IF good_cutout_exists AND NOT _explicit_reprocess THEN[\s\S]*'already_completed'/,
  );
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.reprocess_vehicle_background_removal/,
  );
  assert.match(migration, /queue_vehicle_background_removal_request\([\s\S]*false/);
  assert.match(migration, /queue_vehicle_background_removal_request\([\s\S]*true/);
  assert.match(migration, /variant\.variant_type = 'original'/);
  assert.match(migration, /'source_variant_type', 'original'/);
  assert.match(migration, /'request_mode',[\s\S]*'explicit_reprocess_from_original'/);
  assert.match(migration, /'vehicle_photo\.review_reprocess_requested'/);
  assert.match(migration, /current_user_has_store_capability\(target\.dealership_id, 'media'\)/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.reprocess_vehicle_background_removal\(uuid, uuid\[\]\)/,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.reprocess_vehicle_background_removal\(uuid, uuid\[\]\)[\s\S]*TO authenticated/,
  );
});

test("worker reprocessing reads the immutable original and appends then promotes a new result", () => {
  const sourceMigration = read(
    "supabase/migrations/20260819210739_background_processing_state_controls.sql",
  );
  const finalizationMigration = read(
    "supabase/migrations/20260819220143_background_removal_failure_diagnostics.sql",
  );
  assert.match(
    sourceMigration,
    /variant\.variant_type = 'original' AND variant\.archived_at IS NULL/,
  );
  assert.match(finalizationMigration, /INSERT INTO public\.media_variants/);
  assert.match(finalizationMigration, /\(source->>'source_variant_id'\)::uuid/);
  assert.match(finalizationMigration, /approved_variant_id = result_id/);
  assert.doesNotMatch(finalizationMigration, /DELETE FROM public\.media_variants/);
});

test("Review visibly reports structured results and refreshes the processing widget", () => {
  const route = read("src/routes/_authenticated/vehicles.$id_.review.tsx");
  assert.match(route, /selectedMediaAssetIds/);
  assert.match(route, /parseBackgroundRemovalQueueResult/);
  assert.match(route, /describeBackgroundRemovalQueueResult/);
  assert.match(route, /announceBackgroundProcessingChange\(\)/);
  assert.match(route, /reprocess_vehicle_background_removal/);
  assert.match(route, /explicitReprocess: reprocessCompleted/);
  assert.doesNotMatch(route, /No new background-removal work was queued/);

  const stage = read("src/components/VehiclePhotoReviewStages.tsx");
  assert.match(stage, /Reprocess completed cutouts from original/);
  assert.match(stage, /queueableReviewPhotoIds\(items, false, reprocessCompleted\)/);
  assert.match(stage, /reprocessing uses immutable originals/);
});
