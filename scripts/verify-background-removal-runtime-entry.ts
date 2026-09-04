import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { analyzeBackgroundMask } from "../worker/background-removal-diagnostics.ts";
import { createTransparentVehicleCutoutResult } from "../worker/media.ts";

const fixture = await readFile(
  path.resolve(process.cwd(), "scripts/background-removal-runtime-fixture.jpg"),
);
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

assert.deepEqual(result.inference.input_shape, [1, 3, 1024, 1024]);
assert.deepEqual(result.inference.output_shape, [1, 1, 1024, 1024]);
assert.equal(output.format, "png");
assert.equal(output.hasAlpha, true);
assert.equal(result.inference.output_alpha_channels, 1);
assert.ok(result.diagnostics.alpha_max > result.diagnostics.alpha_min);
assert.notEqual(outputMask.quality, "bad", "Encoded output alpha must remain spatially valid.");
assert.ok(
  Math.abs(outputMask.diagnostics.alpha_mean - result.diagnostics.alpha_mean) < 0.001,
  "Persisted alpha diagnostics must describe the encoded output, not only the model tensor.",
);
assert.ok(
  peakRssMiB < 900,
  `Background-removal runtime peaked at ${peakRssMiB.toFixed(1)} MiB; the 1 GiB worker no longer has a safe operating margin.`,
);

process.stdout.write(
  `${JSON.stringify({
    event: "background_removal.production_node_runtime_verified",
    runtime: `node-${process.versions.node}`,
    duration_ms: Math.round(performance.now() - startedAt),
    session_run_ms: result.inference.session_run_ms,
    peak_rss_mib: Math.round(peakRssMiB * 10) / 10,
    input_shape: result.inference.input_shape,
    output_shape: result.inference.output_shape,
    output_bytes: result.bytes.length,
    quality: result.quality,
    output_alpha_channels: result.inference.output_alpha_channels,
    output_components: outputMask.diagnostics.component_count,
  })}\n`,
);
