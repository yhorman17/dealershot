import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { createTransparentVehicleCutoutResult } from "../worker/media.ts";

const fixture = await readFile(
  path.resolve(process.cwd(), "scripts/background-removal-runtime-fixture.jpg"),
);
const startedAt = performance.now();
const result = await createTransparentVehicleCutoutResult(fixture);
const output = await sharp(result.bytes).metadata();
const peakRssMiB = process.resourceUsage().maxRSS / 1024;

assert.deepEqual(result.inference.input_shape, [1, 3, 1024, 1024]);
assert.deepEqual(result.inference.output_shape, [1, 1, 1024, 1024]);
assert.equal(output.format, "png");
assert.equal(output.hasAlpha, true);
assert.ok(result.diagnostics.alpha_max > result.diagnostics.alpha_min);
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
  })}\n`,
);
