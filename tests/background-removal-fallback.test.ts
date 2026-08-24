import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyzeBackgroundMask,
  BackgroundProcessingError,
  classifyBackgroundFailure,
} from "../worker/background-removal-diagnostics.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const migration = read(
  "supabase/migrations/20260819220143_background_removal_failure_diagnostics.sql",
);

function rectangleMask(
  width: number,
  height: number,
  rectangles: Array<{ x: number; y: number; width: number; height: number }>,
) {
  const alpha = new Uint8Array(width * height);
  for (const rectangle of rectangles) {
    for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += 1) {
      for (let x = rectangle.x; x < rectangle.x + rectangle.width; x += 1) {
        alpha[y * width + x] = 255;
      }
    }
  }
  return alpha;
}

test("mask diagnostics distinguish good, fixable, and unusable ISNet output", () => {
  const good = analyzeBackgroundMask(
    rectangleMask(100, 80, [{ x: 15, y: 20, width: 70, height: 40 }]),
    100,
    80,
  );
  assert.equal(good.quality, "good");
  assert.equal(good.diagnostics.draft_usable, true);
  assert.ok(good.diagnostics.foreground_coverage > 0.3);

  const fragmented = analyzeBackgroundMask(
    rectangleMask(100, 80, [
      { x: 8, y: 22, width: 32, height: 35 },
      { x: 60, y: 22, width: 32, height: 35 },
    ]),
    100,
    80,
  );
  assert.equal(fragmented.quality, "needs_review");
  assert.equal(fragmented.diagnostics.draft_usable, true);
  assert.ok(fragmented.diagnostics.reasons.includes("fragmented_mask"));

  const uniform = analyzeBackgroundMask(new Uint8Array(100 * 80), 100, 80);
  assert.equal(uniform.quality, "bad");
  assert.equal(uniform.diagnostics.draft_usable, false);
  assert.ok(uniform.diagnostics.reasons.includes("no_foreground"));
});

test("failures retain safe categories and only transient work retries automatically", () => {
  assert.deepEqual(classifyBackgroundFailure(new Error("storage_download_failed")), {
    code: "storage_download_failed",
    category: "transient",
    retryable: true,
    diagnostics: {},
  });
  assert.deepEqual(classifyBackgroundFailure(new Error("unsupported_media_type")), {
    code: "unsupported_media_type",
    category: "source_invalid",
    retryable: false,
    diagnostics: {},
  });
  const rejection = classifyBackgroundFailure(
    new BackgroundProcessingError("background_inference_mask_invalid", "model_rejection", false, {
      foreground_coverage: 0,
    }),
  );
  assert.equal(rejection.retryable, false);
  assert.equal(rejection.category, "model_rejection");
  assert.deepEqual(rejection.diagnostics, { foreground_coverage: 0 });
});

test("production worker reports the first real stage and does not cache rejected model startup", () => {
  const worker = read("worker/media.ts");
  const runtime = read("worker/runtime.ts");
  assert.match(worker, /background_runtime_unavailable/);
  assert.match(worker, /background_model_initialization_failed/);
  assert.match(worker, /background_source_decode_failed/);
  assert.match(worker, /background_inference_runtime_failed/);
  assert.match(worker, /background_output_encode_failed/);
  assert.match(worker, /backgroundRemovalRuntime = null/);
  assert.match(worker, /background_worker_bundle_native_import_failed/);
  assert.match(worker, /stage: "runtime_import"/);
  assert.match(worker, /stage: "session_run"/);
  assert.match(worker, /input_shape/);
  assert.match(worker, /output_shape/);
  assert.doesNotMatch(worker, /catch \{\s*throw new Error\("background_inference_failed"\)/);
  assert.match(runtime, /classifyBackgroundFailure/);
  assert.match(runtime, /failure_category: failure\.category/);
});

test("production worker keeps ONNX native loading external and verifies a real tensor path", () => {
  const workerConfig = read("vite.worker.config.ts");
  const runtimeVerifierConfig = read("vite.worker-verify.config.ts");
  const packageJson = read("package.json");
  const runtimeCheck = read("scripts/verify-background-removal-worker-runtime.mjs");
  const productionRuntimeCheck = read("scripts/verify-background-removal-runtime-entry.ts");
  assert.match(workerConfig, /external: \["onnxruntime-node"\]/);
  assert.match(runtimeVerifierConfig, /external: \["onnxruntime-node"\]/);
  assert.match(packageJson, /verify:worker-bg-runtime/);
  assert.match(packageJson, /build:worker-verify/);
  assert.match(runtimeCheck, /Production worker must load ONNX Runtime/);
  assert.match(runtimeCheck, /createTransparentVehicleCutoutResult/);
  assert.match(runtimeCheck, /tensor_elements/);
  assert.match(runtimeCheck, /output_elements/);
  assert.match(runtimeCheck, /output\.hasAlpha/);
  assert.match(productionRuntimeCheck, /background_removal\.production_node_runtime_verified/);
  assert.match(productionRuntimeCheck, /peakRssMiB < 900/);
});

test("production container uses a glibc runtime compatible with ONNX Runtime Node", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /FROM oven\/bun:1\.2\.22 AS build/);
  assert.match(dockerfile, /FROM node:22\.18\.0-bookworm-slim AS runtime/);
  assert.doesNotMatch(dockerfile, /node:22\.18\.0-alpine AS runtime/);
  assert.match(dockerfile, /onnxruntime-node/);
  assert.match(dockerfile, /RUN node \.worker-verify\/verify\.mjs/);
});

test("poor usable masks append drafts without promoting immutable originals", () => {
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.worker_commit_background_cutout_result/,
  );
  assert.match(migration, /_quality_class NOT IN \('good', 'needs_review'\)/);
  assert.match(migration, /CASE WHEN _quality_class = 'good' THEN 'prepared' ELSE 'draft' END/);
  assert.match(migration, /cutout_status = 'needs_review'/);
  assert.match(migration, /processing_action = 'manual_review'/);
  assert.match(migration, /draft_variant_id = result_id/);
  assert.doesNotMatch(migration, /DELETE FROM public\.media_assets|DELETE FROM public\.photos/);
});

test("retry policy stops repeated deterministic failures and keeps attempt history", () => {
  assert.match(
    migration,
    /job\.failure_category IN \('model_rejection', 'resource_failure'\)[\s\S]*job\.deterministic_failure_count < 2/,
  );
  assert.match(migration, /job\.failure_category = 'source_invalid' THEN false/);
  assert.match(migration, /job\.failure_category IN \('transient', 'finalization_failure'\)/);
  assert.match(migration, /failure_category = 'resource_failure'/);
  assert.doesNotMatch(migration, /DELETE FROM private\.background_job_attempts/);
});

test("needs-review jobs expose Fix Cutout and do not enable experimental segmentation", () => {
  const widget = read("src/components/BackgroundProcessingStatus.tsx");
  const dockerfile = read("Dockerfile");
  assert.match(widget, /fix_cutout_available/);
  assert.match(widget, /Fix Cutout/);
  assert.match(widget, /search: \{ customize: job\.photo_id \}/);
  assert.match(widget, /Needs review — original retained/);
  assert.doesNotMatch(dockerfile, /VEHICLE_AWARE_BACKGROUND_REMOVAL=1/);
});
