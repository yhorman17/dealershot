import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  createVehicleAwareCutout,
  expandVehicleRegion,
  scoreVehicleMask,
  selectPrimaryVehicle,
  type VehicleDetection,
} from "../worker/vehicle-aware-cutout.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(
  path.join(root, "supabase/migrations/20260818215500_vehicle_aware_cutout_experiment.sql"),
  "utf8",
);
const worker = readFileSync(path.join(root, "worker/media.ts"), "utf8");

function detection(
  x: number,
  y: number,
  width: number,
  height: number,
  confidence: number,
): VehicleDetection {
  return { box: { x, y, width, height }, confidence, classId: 2, className: "car" };
}

test("primary vehicle ranking prefers a dominant centered vehicle over a small background car", () => {
  const selection = selectPrimaryVehicle(
    [detection(250, 170, 500, 350, 0.72), detection(50, 30, 90, 55, 0.96)],
    1_000,
    700,
  );
  assert.equal(selection.primary?.box.width, 500);
  assert.equal(selection.ambiguous, false);
});

test("similar separated vehicles are considered ambiguous instead of silently choosing one", () => {
  const selection = selectPrimaryVehicle(
    [detection(80, 170, 360, 260, 0.91), detection(560, 170, 350, 255, 0.9)],
    1_000,
    700,
  );
  assert.equal(selection.ambiguous, true);
});

test("vehicle ROI padding preserves edge geometry and clamps to image bounds", () => {
  assert.deepEqual(expandVehicleRegion({ x: 10, y: 20, width: 500, height: 250 }, 800, 500), {
    x: 0,
    y: 0,
    width: 550,
    height: 290,
  });
  const edge = expandVehicleRegion({ x: 720, y: 420, width: 75, height: 70 }, 800, 500);
  assert.equal(edge.x + edge.width, 800);
  assert.equal(edge.y + edge.height >= 490, true);
});

function rectangularMask(width: number, height: number, box: [number, number, number, number]) {
  const mask = new Uint8Array(width * height);
  for (let y = box[1]; y < box[3]; y += 1) {
    for (let x = box[0]; x < box[2]; x += 1) mask[y * width + x] = 1;
  }
  return mask;
}

test("quality gate distinguishes good, questionable, and bad vehicle masks", () => {
  const goodMask = rectangularMask(100, 80, [12, 16, 88, 68]);
  const good = scoreVehicleMask({
    mask: goodMask,
    width: 100,
    height: 80,
    detectorBox: { x: 10, y: 12, width: 80, height: 60 },
    detectorConfidence: 0.95,
    primaryComponentRatio: 0.99,
    enclosedHoleArea: 0,
    ambiguous: false,
  });
  assert.equal(good.rating, "good");

  const questionable = scoreVehicleMask({
    mask: goodMask,
    width: 100,
    height: 80,
    detectorBox: { x: 10, y: 12, width: 80, height: 60 },
    detectorConfidence: 0.95,
    primaryComponentRatio: 0.99,
    enclosedHoleArea: 0,
    ambiguous: true,
  });
  assert.equal(questionable.rating, "questionable");
  assert.match(questionable.reasons.join(","), /ambiguous_primary_vehicle/);

  const clipped = scoreVehicleMask({
    mask: rectangularMask(100, 80, [0, 0, 100, 80]),
    width: 100,
    height: 80,
    detectorBox: { x: 10, y: 12, width: 80, height: 60 },
    detectorConfidence: 0.95,
    primaryComponentRatio: 0.99,
    enclosedHoleArea: 0,
    ambiguous: false,
  });
  assert.equal(clipped.rating, "questionable");
  assert.match(clipped.reasons.join(","), /unexpected_roi_edge_contact/);

  const bad = scoreVehicleMask({
    mask: rectangularMask(100, 80, [10, 10, 18, 18]),
    width: 100,
    height: 80,
    detectorBox: { x: 10, y: 12, width: 80, height: 60 },
    detectorConfidence: 0.9,
    primaryComponentRatio: 0.5,
    enclosedHoleArea: 50,
    ambiguous: false,
  });
  assert.equal(bad.rating, "bad");
  assert.match(bad.reasons.join(","), /insufficient_vehicle_coverage/);
});

test("ROI cutout maps to original coordinates and removes unrelated disconnected foreground", async () => {
  const original = await sharp({
    create: { width: 400, height: 300, channels: 3, background: "#171717" },
  })
    .jpeg()
    .toBuffer();
  const originalChecksum = await crypto.subtle.digest("SHA-256", original);
  const result = await createVehicleAwareCutout(
    original,
    async (source) => {
      const metadata = await sharp(source).metadata();
      const width = metadata.width ?? 1;
      const height = metadata.height ?? 1;
      const vehicle = await sharp({
        create: {
          width: Math.round(width * 0.78),
          height: Math.round(height * 0.62),
          channels: 4,
          background: { r: 12, g: 12, b: 12, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
      const person = await sharp({
        create: {
          width: Math.max(2, Math.round(width * 0.03)),
          height: Math.max(3, Math.round(height * 0.15)),
          channels: 4,
          background: { r: 220, g: 50, b: 50, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
      return sharp({
        create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([
          { input: vehicle, left: Math.round(width * 0.11), top: Math.round(height * 0.2) },
          { input: person, left: Math.round(width * 0.94), top: Math.round(height * 0.05) },
        ])
        .png()
        .toBuffer();
    },
    async () => [detection(70, 85, 260, 140, 0.94)],
  );
  const output = await sharp(result.bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(output.info.width, 400);
  assert.equal(output.info.height, 300);
  assert.equal(output.data[(10 * 400 + 10) * 4 + 3], 0);
  assert.equal(output.data[(120 * 400 + 200) * 4 + 3] > 0, true);
  assert.equal(output.data[(75 * 400 + 345) * 4 + 3], 0);
  assert.deepEqual(await crypto.subtle.digest("SHA-256", original), originalChecksum);
  assert.equal(result.detector.selected?.className, "car");
});

test("small enclosed glass-like holes are conservatively repaired without losing dark pixels", async () => {
  const original = await sharp({
    create: { width: 240, height: 160, channels: 3, background: "#050505" },
  })
    .png()
    .toBuffer();
  const result = await createVehicleAwareCutout(
    original,
    async (source) => {
      const metadata = await sharp(source).metadata();
      const width = metadata.width ?? 1;
      const height = metadata.height ?? 1;
      const pixels = Buffer.alloc(width * height * 4, 0);
      for (let y = 12; y < height - 12; y += 1) {
        for (let x = 10; x < width - 10; x += 1) {
          const offset = (y * width + x) * 4;
          pixels[offset] = 4;
          pixels[offset + 1] = 4;
          pixels[offset + 2] = 4;
          pixels[offset + 3] = 255;
        }
      }
      for (let y = 45; y < 50; y += 1) {
        for (let x = 90; x < 96; x += 1) pixels[(y * width + x) * 4 + 3] = 0;
      }
      return sharp(pixels, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
    },
    async () => [detection(25, 35, 190, 90, 0.96)],
  );
  const alpha = await sharp(result.bytes).extractChannel(3).raw().toBuffer();
  assert.equal(alpha[80 * 240 + 120] > 0, true);
  assert.notEqual(result.quality.rating, "bad");
});

test("no detector result uses standard remover as a non-promoted fallback", async () => {
  const original = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "#ddd" },
  })
    .png()
    .toBuffer();
  let calls = 0;
  const result = await createVehicleAwareCutout(
    original,
    async (source) => {
      calls += 1;
      return sharp(source).ensureAlpha().png().toBuffer();
    },
    async () => [],
  );
  assert.equal(calls, 1);
  assert.equal(result.method, "standard_fallback");
  assert.equal(result.quality.rating, "bad");
  assert.deepEqual(result.quality.reasons, ["no_vehicle_detected"]);
});

test("ledger finalization only auto-promotes good masks and keeps questionable drafts fixable", () => {
  assert.match(migration, /_quality_class NOT IN \('good', 'questionable', 'bad'\)/);
  assert.match(migration, /IF _quality_class = 'good' THEN[\s\S]*approved_variant_id = result_id/);
  assert.match(
    migration,
    /ELSIF _quality_class = 'questionable' THEN[\s\S]*cutout_status = 'needs_review'/,
  );
  assert.match(migration, /ELSE[\s\S]*processing_error = 'mask_quality_bad'/);
  assert.match(migration, /SET search_path = ''/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /TO service_role/);
});

test("vehicle-aware worker strategy is opt-in and the standard remover remains the default", () => {
  assert.match(worker, /VEHICLE_AWARE_BACKGROUND_REMOVAL/);
  assert.match(worker, /=== "1"/);
  assert.match(worker, /worker_commit_background_cutout/);
  assert.match(worker, /worker_commit_vehicle_aware_cutout/);
});
