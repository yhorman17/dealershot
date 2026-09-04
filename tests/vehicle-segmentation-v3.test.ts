import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  classifyFullVehicleGeometry,
  createVehicleSegmentationV3Cutout,
  scoreVehicleMask,
  selectPrimaryVehicle,
  type VehicleDetection,
} from "../worker/vehicle-segmentation-v3.ts";
import { refineAutomotiveMask, type BoundingBox } from "../worker/vehicle-segmentation-v2.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envExample = readFileSync(path.join(root, ".env.example"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const deploymentSpec = readFileSync(path.join(root, ".do/app.yaml"), "utf8");
const workerMedia = readFileSync(path.join(root, "worker/media.ts"), "utf8");
const v3Source = readFileSync(path.join(root, "worker/vehicle-segmentation-v3.ts"), "utf8");
const isolatedSource = readFileSync(
  path.join(root, "worker/vehicle-segmentation-v3-isolated.ts"),
  "utf8",
);
const assetSource = readFileSync(
  path.join(root, "scripts/vehicle-segmentation-v3-assets.mjs"),
  "utf8",
);
const authorizationMigration = readFileSync(
  path.join(root, "supabase/migrations/20260818190335_bulk_first_capture_workflow.sql"),
  "utf8",
);
const reviewRolloutMigration = readFileSync(
  path.join(root, "supabase/migrations/20260824130734_vehicle_segmentation_v3_review_rollout.sql"),
  "utf8",
);

function detection(box: BoundingBox, confidence = 0.94): VehicleDetection {
  return { box, confidence, classId: 2, className: "car" };
}

function rectangleMask(width: number, height: number, box: BoundingBox) {
  const mask = new Uint8Array(width * height);
  for (
    let y = Math.max(0, Math.floor(box.y));
    y < Math.min(height, Math.ceil(box.y + box.height));
    y += 1
  ) {
    for (
      let x = Math.max(0, Math.floor(box.x));
      x < Math.min(width, Math.ceil(box.x + box.width));
      x += 1
    )
      mask[y * width + x] = 1;
  }
  return mask;
}

test("complete dark/side/rear vehicle geometry passes while partial, wheel, engine, and interior-like frames fail closed", () => {
  for (const box of [
    { x: 120, y: 170, width: 760, height: 360 },
    { x: 70, y: 240, width: 860, height: 280 },
    { x: 180, y: 120, width: 640, height: 430 },
    { x: 0, y: 175, width: 760, height: 350 },
  ]) {
    assert.equal(
      classifyFullVehicleGeometry({
        detection: detection(box),
        width: 1_000,
        height: 700,
        ambiguous: false,
      }).classification,
      "FULL_VEHICLE",
    );
  }
  for (const box of [
    { x: 0, y: 0, width: 1_000, height: 690 },
    { x: 420, y: 520, width: 110, height: 80 },
    { x: 0, y: 0, width: 990, height: 700 },
    { x: 0, y: 40, width: 1_000, height: 600 },
  ]) {
    assert.notEqual(
      classifyFullVehicleGeometry({
        detection: detection(box, 0.86),
        width: 1_000,
        height: 700,
        ambiguous: false,
      }).classification,
      "FULL_VEHICLE",
    );
  }
  assert.equal(
    classifyFullVehicleGeometry({ detection: null, width: 1_000, height: 700, ambiguous: false })
      .classification,
    "NON_VEHICLE",
  );
});

test("dominant complete car wins, a background vehicle is ignored, and two plausible cars become ambiguous", () => {
  const dominant = selectPrimaryVehicle(
    [
      detection({ x: 100, y: 150, width: 760, height: 400 }, 0.9),
      detection({ x: 850, y: 80, width: 80, height: 45 }, 0.99),
    ],
    1_000,
    700,
  );
  assert.equal(dominant.primary?.box.width, 760);
  assert.equal(dominant.ambiguous, false);
  const twoCars = selectPrimaryVehicle(
    [
      detection({ x: 30, y: 200, width: 440, height: 300 }),
      detection({ x: 525, y: 205, width: 435, height: 295 }, 0.93),
    ],
    1_000,
    700,
  );
  assert.equal(twoCars.ambiguous, true);
  assert.equal(
    classifyFullVehicleGeometry({
      detection: twoCars.primary,
      width: 1_000,
      height: 700,
      ambiguous: true,
    }).classification,
    "AMBIGUOUS",
  );
});

test("padded high-resolution mask preserves mirrors, wheels, windows, and excludes a disconnected person", () => {
  const width = 200;
  const height = 130;
  const mask = rectangleMask(width, height, { x: 35, y: 35, width: 130, height: 62 });
  for (const [x, y, w, h] of [
    [24, 52, 12, 7],
    [48, 92, 22, 20],
    [132, 92, 22, 20],
    [185, 6, 6, 22],
  ]) {
    for (let yy = y; yy < y + h; yy += 1)
      for (let xx = x; xx < x + w; xx += 1) mask[yy * width + xx] = 1;
  }
  for (let y = 50; y < 54; y += 1) for (let x = 78; x < 86; x += 1) mask[y * width + x] = 0;
  const refined = refineAutomotiveMask(mask, width, height);
  assert.equal(refined.mask[55 * width + 28], 1, "mirror retained");
  assert.equal(refined.mask[101 * width + 55], 1, "wheel retained");
  assert.equal(refined.mask[52 * width + 82], 1, "small glass hole filled");
  assert.equal(refined.mask[12 * width + 188], 0, "person removed");
});

test("GOOD, review, and BAD quality outcomes remain conservative", () => {
  const width = 320;
  const height = 220;
  const selected = detection({ x: 35, y: 55, width: 250, height: 120 }, 0.98);
  const eligibility = classifyFullVehicleGeometry({
    detection: selected,
    width,
    height,
    ambiguous: false,
  });
  const goodMask = rectangleMask(width, height, { x: 43, y: 62, width: 234, height: 108 });
  const goodRefinement = refineAutomotiveMask(goodMask, width, height);
  const good = scoreVehicleMask({
    mask: goodMask,
    width,
    height,
    detection: selected,
    eligibility,
    predictorScore: 0.97,
    refinement: goodRefinement,
  });
  assert.equal(good.rating, "good");

  const sparse = rectangleMask(width, height, { x: 95, y: 83, width: 125, height: 58 });
  const sparseRefinement = refineAutomotiveMask(sparse, width, height);
  const questionable = scoreVehicleMask({
    mask: sparse,
    width,
    height,
    detection: selected,
    eligibility,
    predictorScore: 0.68,
    refinement: sparseRefinement,
  });
  assert.ok(["needs_review", "bad"].includes(questionable.rating));

  const partialEligibility = classifyFullVehicleGeometry({
    detection: detection({ x: 0, y: 0, width: 320, height: 220 }),
    width,
    height,
    ambiguous: false,
  });
  const bad = scoreVehicleMask({
    mask: goodMask,
    width,
    height,
    detection: selected,
    eligibility: partialEligibility,
    predictorScore: 0.99,
    refinement: goodRefinement,
  });
  assert.equal(bad.rating, "bad");
});

test("the V3 pipeline appends a transparent derivative, keeps the original immutable, and skips segmentation for partial images", async () => {
  const original = await sharp({
    create: { width: 320, height: 220, channels: 3, background: "#090909" },
  })
    .jpeg()
    .toBuffer();
  const checksum = Buffer.from(await crypto.subtle.digest("SHA-256", original)).toString("hex");
  const box = { x: 35, y: 55, width: 250, height: 120 };
  let segmentCalls = 0;
  const result = await createVehicleSegmentationV3Cutout(original, {
    detector: async () => [detection(box, 0.99)],
    segmenter: async () => {
      segmentCalls += 1;
      return {
        mask: rectangleMask(320, 220, { x: 43, y: 62, width: 234, height: 108 }),
        predictorScore: 0.97,
        maskIndex: 1,
      };
    },
  });
  assert.equal(segmentCalls, 1);
  assert.ok(result.bytes);
  assert.equal((await sharp(result.bytes).metadata()).hasAlpha, true);
  assert.equal(
    Buffer.from(await crypto.subtle.digest("SHA-256", original)).toString("hex"),
    checksum,
  );
  assert.equal(result.metadata.method, "detector_box_prompted_segmentation");

  const rejected = await createVehicleSegmentationV3Cutout(original, {
    detector: async () => [detection({ x: 0, y: 0, width: 320, height: 220 })],
    segmenter: async () => {
      segmentCalls += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(rejected.bytes, null);
  assert.equal(segmentCalls, 1);
});

test("V3 stays disabled in hosted production and requires an explicit review-rollout opt-in", () => {
  assert.match(envExample, /^VEHICLE_AWARE_BACKGROUND_REMOVAL=0$/m);
  assert.match(envExample, /^VEHICLE_SEGMENTATION_V2=0$/m);
  assert.match(envExample, /^VEHICLE_SEGMENTATION_V3=0$/m);
  assert.match(packageJson.scripts.build, /build:worker-v3/);
  assert.match(packageJson.scripts.build, /verify:worker-v3-runtime/);
  assert.doesNotMatch(packageJson.scripts["build:worker"], /vehicle-segmentation-v3/);
  assert.match(workerMedia, /VEHICLE_SEGMENTATION_V3/);
  assert.match(workerMedia, /worker_commit_vehicle_segmentation_v3_review/);
  assert.match(workerMedia, /rollout_policy: "review_required"/);
  assert.match(deploymentSpec, /key: VEHICLE_SEGMENTATION_V3[\s\S]*?value: "0"/);
  assert.match(deploymentSpec, /key: VEHICLE_SEGMENTATION_V3_REVIEW_ROLLOUT[\s\S]*?value: "0"/);
  assert.match(workerMedia, /vehicleSegmentationV3RolloutEnabled/);
  assert.match(workerMedia, /VEHICLE_SEGMENTATION_V3_REVIEW_ROLLOUT/);
  assert.match(dockerfile, /\.worker-v3/);
  assert.match(dockerfile, /worker-assets\/vehicle-segmentation-v3/);
  assert.match(dockerfile, /verify-vehicle-segmentation-v3-worker-runtime\.mjs/);
  assert.match(dockerfile, /node_modules\/sharp \.\/node_modules\/sharp/);
  assert.match(dockerfile, /node_modules\/detect-libc \.\/node_modules\/detect-libc/);
  assert.match(dockerfile, /node_modules\/semver \.\/node_modules\/semver/);
  assert.match(dockerfile, /node_modules\/@img \.\/node_modules\/@img/);
  assert.match(dockerfile, /await import\('sharp'\)/);
  assert.match(dockerfile, /sharp\.versions\.sharp !== '0\.35\.3'/);
  assert.match(reviewRolloutMigration, /worker_commit_vehicle_segmentation_v3_review/);
  assert.match(reviewRolloutMigration, /'needs_review'/);
  assert.match(reviewRolloutMigration, /'auto_promoted', false/);
  assert.match(reviewRolloutMigration, /'rollout_policy', 'review_required'/);
  assert.match(
    reviewRolloutMigration,
    /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/,
  );
  assert.match(reviewRolloutMigration, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/);
});

test("RT-DETRv2 and MobileSAM code and weights are pinned to Apache-2.0 provenance", () => {
  assert.match(assetSource, /RT-DETRv2 R18vd COCO/);
  assert.match(assetSource, /MobileSAM ViT-T/);
  assert.equal((assetSource.match(/codeLicense: "Apache-2.0"/g) ?? []).length, 2);
  assert.equal((assetSource.match(/weightsLicense: "Apache-2.0"/g) ?? []).length, 2);
  assert.match(assetSource, /068dfde65f2667ad6555883c69d73de886518cad/);
  assert.match(assetSource, /f706ad9c4eb7f219c00d9050e46328518ffb65d2/);
  assert.match(assetSource, /checkpointSha256/);
});

test("isolated child execution is bounded, timed out, releasable, and does not persist a model session", () => {
  assert.match(isolatedSource, /MAX_CONCURRENCY = 1/);
  assert.match(isolatedSource, /DEFAULT_TIMEOUT_MS = 45_000/);
  assert.match(isolatedSource, /spawn\(\s*process\.execPath/);
  assert.match(isolatedSource, /DEALERSHOT_V3_CHILD_PATH/);
  assert.match(isolatedSource, /child\.kill\(\)/);
  assert.match(v3Source, /releaseVehicleSegmentationV3Runtime/);
  assert.match(v3Source, /enableCpuMemArena: false/);
  assert.match(v3Source, /enableMemPattern: false/);
});

test("existing capability and tenant authorization still gates queueing and worker source access", () => {
  assert.match(authorizationMigration, /queue_bulk_background_removal/);
  assert.match(
    authorizationMigration,
    /current_user_has_store_capability\(target\.dealership_id,'media'\)/,
  );
  assert.match(
    authorizationMigration,
    /current_user_has_store_capability\(target\.dealership_id,'capture'\)/,
  );
  assert.match(authorizationMigration, /worker_get_background_removal_source/);
  assert.match(
    authorizationMigration,
    /REVOKE ALL ON FUNCTION public\.queue_bulk_background_removal/,
  );
});
