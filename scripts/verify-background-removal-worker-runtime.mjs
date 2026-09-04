import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { analyzeBackgroundMask } from "../worker/background-removal-diagnostics.ts";
import { createTransparentVehicleCutoutResult } from "../worker/media.ts";

const root = path.resolve(import.meta.dirname, "..");
const workerBundle = await readFile(path.join(root, ".worker", "index.mjs"), "utf8");

assert.match(
  workerBundle,
  /import\(["']onnxruntime-node["']\)/,
  "Production worker must load ONNX Runtime from its package directory.",
);
assert.doesNotMatch(
  workerBundle,
  /commonjsRequire\(`\.\.\/bin\/napi-v6\/\$\{process\.platform\}/,
  "Production worker must not bundle ONNX Runtime's native binding lookup.",
);

// This crop comes from the repository's licensed controlled V3 benchmark
// contact sheet. It is local-only test material and never leaves the process.
const fixture = await sharp(
  path.join(
    root,
    "artifacts",
    "vehicle-segmentation-v3",
    "vehicle-segmentation-v3-contact-sheet.jpg",
  ),
)
  .extract({ left: 0, top: 0, width: 430, height: 280 })
  .jpeg({ quality: 90 })
  .toBuffer();

const startedAt = performance.now();
const result = await createTransparentVehicleCutoutResult(fixture);
const output = await sharp(result.bytes).metadata();
const outputAlpha = await sharp(result.bytes)
  .ensureAlpha()
  .extractChannel(3)
  .raw()
  .toBuffer({ resolveWithObject: true });
const outputMask = analyzeBackgroundMask(
  outputAlpha.data,
  outputAlpha.info.width,
  outputAlpha.info.height,
);
const peakRssMiB = process.resourceUsage().maxRSS / 1024;

assert.equal(result.inference.input_name, "input");
assert.deepEqual(result.inference.input_shape, [1, 3, 1024, 1024]);
assert.equal(result.inference.tensor_elements, 3 * 1024 * 1024);
assert.equal(result.inference.output_name, "output");
assert.deepEqual(result.inference.output_shape, [1, 1, 1024, 1024]);
assert.equal(result.inference.output_elements, 1024 * 1024);
assert.equal(output.format, "png");
assert.equal(output.hasAlpha, true);
assert.equal(result.inference.output_alpha_channels, 1);
assert.ok(result.diagnostics.alpha_max > result.diagnostics.alpha_min);
assert.notEqual(outputMask.quality, "bad", "Encoded output alpha must remain spatially valid.");
assert.ok(
  Math.abs(outputMask.diagnostics.alpha_mean - result.diagnostics.alpha_mean) < 0.001,
  "Persisted alpha diagnostics must describe the encoded output, not only the model tensor.",
);
// oven/bun exposes `node` as Bun in the Docker build stage. The production
// Node runtime executes the bundled verifier again from Dockerfile, where the
// memory ceiling is authoritative.
if (!process.versions.bun) {
  assert.ok(
    peakRssMiB < 900,
    `Background-removal runtime peaked at ${peakRssMiB.toFixed(1)} MiB; the 1 GiB worker no longer has a safe operating margin.`,
  );
}

console.log(
  JSON.stringify({
    event: "background_removal.production_runtime_verified",
    runtime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.versions.node}`,
    duration_ms: Math.round(performance.now() - startedAt),
    session_run_ms: result.inference.session_run_ms,
    rss_before_mib: result.inference.rss_before_mib,
    rss_after_mib: result.inference.rss_after_mib,
    peak_rss_mib: Math.round(peakRssMiB * 10) / 10,
    input_shape: result.inference.input_shape,
    output_shape: result.inference.output_shape,
    output_bytes: result.bytes.length,
    quality: result.quality,
    alpha_min: result.diagnostics.alpha_min,
    alpha_max: result.diagnostics.alpha_max,
    alpha_mean: result.diagnostics.alpha_mean,
    foreground_coverage: result.diagnostics.foreground_coverage,
    output_alpha_channels: result.inference.output_alpha_channels,
    output_components: outputMask.diagnostics.component_count,
  }),
);
