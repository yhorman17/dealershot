import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  classifyFullVehicle,
  createVehicleSegmentationV2Cutout,
  refineAutomotiveMask,
  selectPrimaryVehicleInstance,
  type BoundingBox,
  type VehicleInstance,
} from "../worker/vehicle-segmentation-v2.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envExample = readFileSync(path.join(root, ".env.example"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const workerMedia = readFileSync(path.join(root, "worker/media.ts"), "utf8");
const modelAsset = readFileSync(
  path.join(root, "scripts/vehicle-segmentation-v2-assets.mjs"),
  "utf8",
);
const processingAuthorizationMigration = readFileSync(
  path.join(root, "supabase/migrations/20260818190335_bulk_first_capture_workflow.sql"),
  "utf8",
);

function rectangleMask(width: number, height: number, box: BoundingBox) {
  const mask = new Uint8Array(width * height);
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(width, Math.ceil(box.x + box.width));
  const bottom = Math.min(height, Math.ceil(box.y + box.height));
  let area = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      mask[y * width + x] = 1;
      area += 1;
    }
  }
  return { mask, area };
}

function instance(
  imageWidth: number,
  imageHeight: number,
  box: BoundingBox,
  confidence = 0.94,
): VehicleInstance {
  const shape = rectangleMask(imageWidth, imageHeight, {
    x: box.x + box.width * 0.06,
    y: box.y + box.height * 0.08,
    width: box.width * 0.88,
    height: box.height * 0.84,
  });
  return {
    box,
    confidence,
    classId: 3,
    className: "car",
    mask: shape.mask,
    maskArea: shape.area,
  };
}

test("complete centered vehicle is eligible while partial, detail, interior, and empty cases fail closed", () => {
  const full = classifyFullVehicle({
    instance: instance(1_000, 700, { x: 130, y: 170, width: 740, height: 380 }),
    imageWidth: 1_000,
    imageHeight: 700,
    ambiguous: false,
  });
  assert.equal(full.classification, "FULL_VEHICLE");

  const partial = classifyFullVehicle({
    instance: instance(1_000, 700, { x: 0, y: 0, width: 1_000, height: 690 }),
    imageWidth: 1_000,
    imageHeight: 700,
    ambiguous: false,
  });
  assert.equal(partial.classification, "PARTIAL_VEHICLE");
  assert.match(partial.reasons.join(","), /clipped|fills_frame/);

  for (const box of [
    { x: 400, y: 510, width: 120, height: 100 },
    { x: 0, y: 0, width: 980, height: 680 },
    { x: 0, y: 0, width: 1_000, height: 700 },
  ]) {
    const detail = classifyFullVehicle({
      instance: instance(1_000, 700, box, 0.82),
      imageWidth: 1_000,
      imageHeight: 700,
      ambiguous: false,
    });
    assert.notEqual(detail.classification, "FULL_VEHICLE");
  }

  const none = classifyFullVehicle({
    instance: null,
    imageWidth: 1_000,
    imageHeight: 700,
    ambiguous: false,
  });
  assert.equal(none.classification, "NON_VEHICLE");
});

test("dark, side-profile, rear-three-quarter, and singly edge-framed complete cars remain eligible", () => {
  for (const box of [
    { x: 120, y: 170, width: 760, height: 360 },
    { x: 70, y: 240, width: 860, height: 280 },
    { x: 180, y: 120, width: 640, height: 430 },
    { x: 0, y: 175, width: 760, height: 350 },
  ]) {
    const result = classifyFullVehicle({
      instance: instance(1_000, 700, box, 0.91),
      imageWidth: 1_000,
      imageHeight: 700,
      ambiguous: false,
    });
    assert.equal(result.classification, "FULL_VEHICLE");
  }
});

test("dominant complete vehicle wins while similarly plausible cars are marked ambiguous", () => {
  const dominant = selectPrimaryVehicleInstance(
    [
      instance(1_000, 700, { x: 100, y: 160, width: 760, height: 400 }, 0.88),
      instance(1_000, 700, { x: 820, y: 100, width: 100, height: 60 }, 0.99),
    ],
    1_000,
    700,
  );
  assert.equal(dominant.primary?.box.width, 760);
  assert.equal(dominant.ambiguous, false);

  const twoCars = selectPrimaryVehicleInstance(
    [
      instance(1_000, 700, { x: 40, y: 210, width: 430, height: 300 }, 0.92),
      instance(1_000, 700, { x: 530, y: 205, width: 420, height: 295 }, 0.91),
    ],
    1_000,
    700,
  );
  assert.equal(twoCars.ambiguous, true);
  assert.equal(
    classifyFullVehicle({
      instance: twoCars.primary,
      imageWidth: 1_000,
      imageHeight: 700,
      ambiguous: true,
    }).classification,
    "AMBIGUOUS",
  );
});

test("automotive refinement keeps nearby mirrors and wheels, fills small glass holes, and removes a distant person", () => {
  const width = 160;
  const height = 100;
  const body = rectangleMask(width, height, { x: 28, y: 28, width: 104, height: 45 }).mask;
  for (const [x, y, w, h] of [
    [18, 42, 10, 6],
    [38, 70, 17, 15],
    [104, 70, 17, 15],
    [148, 8, 5, 18],
  ]) {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) body[yy * width + xx] = 1;
    }
  }
  for (let y = 40; y < 44; y += 1) {
    for (let x = 70; x < 76; x += 1) body[y * width + x] = 0;
  }
  const refined = refineAutomotiveMask(body, width, height);
  assert.equal(refined.mask[44 * width + 22], 1, "mirror must remain");
  assert.equal(refined.mask[76 * width + 46], 1, "wheel must remain");
  assert.equal(refined.mask[42 * width + 72], 1, "small upper-body glass hole must fill");
  assert.equal(refined.mask[12 * width + 150], 0, "distant person component must be removed");
});

test("GOOD, needs-review, and BAD outcomes do not overwrite the immutable original", async () => {
  const original = await sharp({
    create: { width: 320, height: 220, channels: 3, background: "#090909" },
  })
    .jpeg()
    .toBuffer();
  const checksum = Buffer.from(await crypto.subtle.digest("SHA-256", original)).toString("hex");

  const good = await createVehicleSegmentationV2Cutout(original, async () => [
    instance(320, 220, { x: 35, y: 55, width: 250, height: 120 }, 0.99),
  ]);
  assert.ok(good.bytes);
  assert.notEqual(good.quality.rating, "bad");
  assert.equal(good.metadata.method, "vehicle_instance_segmentation");
  assert.equal(
    Buffer.from(await crypto.subtle.digest("SHA-256", original)).toString("hex"),
    checksum,
  );

  const reviewInstance = instance(320, 220, { x: 35, y: 55, width: 250, height: 120 }, 0.92);
  for (let y = 75; y < 112; y += 1) {
    for (let x = 100; x < 220; x += 1) {
      if (reviewInstance.mask[y * 320 + x]) {
        reviewInstance.mask[y * 320 + x] = 0;
        reviewInstance.maskArea -= 1;
      }
    }
  }
  const review = await createVehicleSegmentationV2Cutout(original, async () => [reviewInstance]);
  assert.ok(["needs_review", "bad"].includes(review.quality.rating));

  const bad = await createVehicleSegmentationV2Cutout(original, async () => []);
  assert.equal(bad.quality.rating, "bad");
  assert.equal(bad.bytes, null);
});

test("a questionable draft is transparent-PNG/Fix-Cutout compatible but cannot auto-promote", async () => {
  const original = await sharp({
    create: { width: 280, height: 180, channels: 3, background: "#333" },
  })
    .png()
    .toBuffer();
  const result = await createVehicleSegmentationV2Cutout(original, async () => [
    instance(280, 180, { x: 24, y: 46, width: 232, height: 104 }, 0.82),
  ]);
  assert.ok(result.bytes);
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.hasAlpha, true);
  if (result.quality.rating !== "good") {
    assert.notEqual(result.quality.rating, "good", "draft must not be treated as approved");
  }
});

test("V2 is separately flagged off, absent from normal builds, and leaves V1/production processing unchanged", () => {
  assert.match(envExample, /^VEHICLE_AWARE_BACKGROUND_REMOVAL=0$/m);
  assert.match(envExample, /^VEHICLE_SEGMENTATION_V2=0$/m);
  assert.doesNotMatch(packageJson.scripts.build, /vehicle-segmentation-v2/);
  assert.doesNotMatch(packageJson.scripts["build:worker"], /vehicle-segmentation-v2/);
  assert.doesNotMatch(workerMedia, /VEHICLE_SEGMENTATION_V2/);
  assert.match(workerMedia, /VEHICLE_AWARE_BACKGROUND_REMOVAL/);
});

test("experimental model and weights are pinned to the ONNX Model Zoo MIT artifact", () => {
  assert.match(modelAsset, /codeLicense: "MIT"/);
  assert.match(modelAsset, /weightsLicense: "MIT \(ONNX Model Zoo model card\)"/);
  assert.match(modelAsset, /45_769_352/);
  assert.match(modelAsset, /4409935e855719fd6cd986f7ec2a3de840d0bd9c9cf7a0cba84ce95377f5b476/);
});

test("existing capability and tenant checks remain authoritative for background processing", () => {
  assert.match(processingAuthorizationMigration, /queue_bulk_background_removal/);
  assert.match(
    processingAuthorizationMigration,
    /current_user_has_store_capability\(target\.dealership_id,'media'\)/,
  );
  assert.match(
    processingAuthorizationMigration,
    /current_user_has_store_capability\(target\.dealership_id,'capture'\)/,
  );
  assert.match(processingAuthorizationMigration, /worker_get_background_removal_source/);
  assert.match(
    processingAuthorizationMigration,
    /REVOKE ALL ON FUNCTION public\.queue_bulk_background_removal/,
  );
});

test("runtime is releasable and disables the CPU arena for experiment isolation", () => {
  const source = readFileSync(path.join(root, "worker/vehicle-segmentation-v2.ts"), "utf8");
  assert.match(source, /releaseVehicleSegmentationV2Runtime/);
  assert.match(source, /enableCpuMemArena: false/);
  assert.match(source, /await loaded\.session\.release\(\)/);
});
