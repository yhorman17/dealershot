import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { createTransparentVehicleCutout } from "../worker/media.ts";
import { createVehicleAwareCutout, intersectionOverUnion } from "../worker/vehicle-aware-cutout.ts";
import {
  createVehicleSegmentationV2Cutout,
  detectVehicleInstances,
  releaseVehicleSegmentationV2Runtime,
} from "../worker/vehicle-segmentation-v2.ts";
import { runVehicleSegmentationV3Isolated } from "../worker/vehicle-segmentation-v3-isolated.ts";
import { VEHICLE_SEGMENTATION_V3_ASSETS } from "./vehicle-segmentation-v3-assets.mjs";

const cocoCases = [
  { id: 228942, name: "dark_vehicle_night", eligibility: "FULL_VEHICLE", tags: ["dark"] },
  { id: 354829, name: "light_vehicle_overhead", eligibility: "FULL_VEHICLE", tags: ["light"] },
  { id: 338718, name: "side_profile_suv", eligibility: "FULL_VEHICLE", tags: ["side_profile"] },
  { id: 543043, name: "red_vehicle_outdoors", eligibility: "FULL_VEHICLE", tags: ["outdoor"] },
  { id: 263594, name: "light_vehicle_lot", eligibility: "FULL_VEHICLE", tags: ["lot"] },
  { id: 138979, name: "rear_vehicle_with_bus", eligibility: "FULL_VEHICLE", tags: ["multi_car"] },
  { id: 442456, name: "person_near_vehicle", eligibility: "FULL_VEHICLE", tags: ["person"] },
  { id: 493286, name: "antique_side_profile", eligibility: "FULL_VEHICLE", tags: ["side_profile"] },
  { id: 78823, name: "rear_three_quarter_with_dog", eligibility: "FULL_VEHICLE", tags: ["rear"] },
  { id: 200839, name: "bus_exterior", eligibility: "FULL_VEHICLE", tags: ["large_vehicle"] },
  { id: 97679, name: "similar_multiple_vehicles", eligibility: "AMBIGUOUS", tags: ["multi_car"] },
  { id: 194832, name: "vehicle_interior_negative", eligibility: "NON_VEHICLE", tags: ["interior"] },
  {
    id: 17178,
    name: "partial_vehicle_edge_negative",
    eligibility: "PARTIAL_VEHICLE",
    tags: ["partial"],
  },
  {
    id: 23272,
    name: "hood_glass_detail_negative",
    eligibility: "PARTIAL_VEHICLE",
    tags: ["glass", "partial"],
  },
  { id: 508602, name: "roof_detail_negative", eligibility: "PARTIAL_VEHICLE", tags: ["partial"] },
  {
    id: 107087,
    name: "windshield_detail_negative",
    eligibility: "PARTIAL_VEHICLE",
    tags: ["glass", "partial"],
  },
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const imageDirectory = argument("--images");
const annotationsPath = argument("--annotations");
const controlledDirectory = argument("--controlled");
const outputDirectory = path.resolve(
  argument("--output-directory") ?? "vehicle-segmentation-v3-benchmark",
);
if (!imageDirectory || !annotationsPath || !controlledDirectory) {
  throw new Error(
    "Usage: node scripts/benchmark-vehicle-segmentation-v3.mjs --images <COCO images> --annotations <instances.json> --controlled <licensed fixtures> [--output-directory path]",
  );
}

await mkdir(outputDirectory, { recursive: true });
const coco = JSON.parse(await readFile(annotationsPath, "utf8"));
const controlled = JSON.parse(
  await readFile(path.join(controlledDirectory, "controlled-fixture-manifest.json"), "utf8"),
);
const images = new Map(coco.images.map((image) => [image.id, image]));
const annotations = new Map();
for (const annotation of coco.annotations) {
  const list = annotations.get(annotation.image_id) ?? [];
  list.push(annotation);
  annotations.set(annotation.image_id, list);
}
const vehicleCategoryIds = new Set([3, 6, 8]);

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

async function annotationMask(annotation, width, height) {
  if (!Array.isArray(annotation?.segmentation)) return null;
  const paths = annotation.segmentation
    .filter((polygon) => Array.isArray(polygon) && polygon.length >= 6)
    .map((polygon) => {
      let commands = `M ${polygon[0]} ${polygon[1]}`;
      for (let index = 2; index < polygon.length; index += 2)
        commands += ` L ${polygon[index]} ${polygon[index + 1]}`;
      return `${commands} Z`;
    });
  if (!paths.length) return null;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${paths.join(" ")}" fill="#fff" fill-rule="evenodd"/></svg>`,
  );
  const raw = await sharp(svg).removeAlpha().greyscale().raw().toBuffer();
  return Uint8Array.from(raw, (value) => (value >= 128 ? 1 : 0));
}

function targetAnnotation(definition, image) {
  if (definition.eligibility !== "FULL_VEHICLE") return null;
  return (
    (annotations.get(definition.id) ?? [])
      .filter((annotation) => vehicleCategoryIds.has(annotation.category_id) && !annotation.iscrowd)
      .map((annotation) => {
        const [x, y, width, height] = annotation.bbox;
        const centerDistance = Math.hypot(
          x + width / 2 - image.width / 2,
          y + height / 2 - image.height / 2,
        );
        const center =
          1 - Math.min(1, centerDistance / Math.hypot(image.width / 2, image.height / 2));
        return {
          annotation,
          rank: Math.sqrt((width * height) / (image.width * image.height)) * (0.65 + center * 0.35),
        };
      })
      .sort((left, right) => right.rank - left.rank)[0]?.annotation ?? null
  );
}

async function outputMask(bytes) {
  if (!bytes) return null;
  const { data } = await sharp(bytes)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Uint8Array.from(data, (value) => (value >= 64 ? 1 : 0));
}

function compareMasks(predicted, expected) {
  if (!predicted || !expected) return { maskIoU: null, contamination: null, missingGeometry: null };
  let predictedArea = 0;
  let expectedArea = 0;
  let intersection = 0;
  for (let index = 0; index < expected.length; index += 1) {
    predictedArea += predicted[index];
    expectedArea += expected[index];
    intersection += predicted[index] && expected[index] ? 1 : 0;
  }
  return {
    maskIoU: intersection / Math.max(1, predictedArea + expectedArea - intersection),
    contamination: (predictedArea - intersection) / Math.max(1, predictedArea),
    missingGeometry: (expectedArea - intersection) / Math.max(1, expectedArea),
  };
}

function roundedComparison(comparison) {
  return Object.fromEntries(
    Object.entries(comparison).map(([key, value]) => [key, value === null ? null : round(value)]),
  );
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function tile(bytes, title, width = 210, height = 138) {
  const label = Buffer.from(
    `<svg width="${width}" height="28"><rect width="100%" height="100%" fill="#111827"/><text x="7" y="19" fill="#f9fafb" font-size="11" font-family="Arial">${escapeXml(title)}</text></svg>`,
  );
  const image = bytes
    ? await sharp(bytes)
        .resize(width, height, { fit: "contain", background: "#d1d5db" })
        .flatten({ background: "#d1d5db" })
        .png()
        .toBuffer()
    : await sharp({ create: { width, height, channels: 3, background: "#374151" } })
        .png()
        .toBuffer();
  return sharp({ create: { width, height: height + 28, channels: 3, background: "#111827" } })
    .composite([
      { input: image, left: 0, top: 0 },
      { input: label, left: 0, top: height },
    ])
    .png()
    .toBuffer();
}

async function maskTile(bytes, title) {
  if (!bytes) return tile(null, title);
  return tile(await sharp(bytes).ensureAlpha().extractChannel(3).png().toBuffer(), title);
}

const cases = [];
for (const definition of cocoCases) {
  const image = images.get(definition.id);
  if (!image) throw new Error(`COCO metadata missing for ${definition.id}.`);
  cases.push({
    ...definition,
    sourceType: "CONTROLLED_COCO_FIXTURE",
    file: path.join(imageDirectory, image.file_name),
    image,
  });
}
for (const fixture of controlled.fixtures) {
  cases.push({
    name: fixture.id,
    eligibility: fixture.expectedEligibility,
    tags: [fixture.bodyStyle, fixture.scene, fixture.lighting],
    sourceType: "CONTROLLED_WIKIMEDIA_FIXTURE",
    file: path.join(controlledDirectory, fixture.filename),
    fixture,
  });
}

const results = [];
const contactRows = [];
for (const definition of cases) {
  const source = await readFile(definition.file);
  const metadata = await sharp(source).metadata();
  const target = definition.image ? targetAnnotation(definition, definition.image) : null;
  const expectedMask = target
    ? await annotationMask(target, metadata.width, metadata.height)
    : null;
  const targetBox = target
    ? { x: target.bbox[0], y: target.bbox[1], width: target.bbox[2], height: target.bbox[3] }
    : null;

  const currentStarted = performance.now();
  const currentBytes = await createTransparentVehicleCutout(source);
  const currentMilliseconds = performance.now() - currentStarted;
  const v1Started = performance.now();
  const v1 = await createVehicleAwareCutout(source, createTransparentVehicleCutout);
  const v1Milliseconds = performance.now() - v1Started;
  const v2Started = performance.now();
  const v2Instances = await detectVehicleInstances(source);
  const v2 = await createVehicleSegmentationV2Cutout(source, async () => v2Instances);
  const v2Milliseconds = performance.now() - v2Started;
  const v3Started = performance.now();
  const v3 = await runVehicleSegmentationV3Isolated(source, { timeoutMs: 60_000 });
  const v3Milliseconds = performance.now() - v3Started;

  const currentComparison = compareMasks(await outputMask(currentBytes), expectedMask);
  const v1Comparison = compareMasks(await outputMask(v1.bytes), expectedMask);
  const v2Comparison = compareMasks(await outputMask(v2.bytes), expectedMask);
  const v3Comparison = compareMasks(await outputMask(v3.rawBytes), expectedMask);
  const v3RefinedComparison = compareMasks(await outputMask(v3.refinedBytes), expectedMask);
  const selectedBox = v3.selected?.box ?? null;
  const selectionIoU =
    targetBox && selectedBox ? intersectionOverUnion(targetBox, selectedBox) : null;
  const exactEligibilityCorrect = v3.eligibility.classification === definition.eligibility;
  const automaticGateCorrect =
    (definition.eligibility === "FULL_VEHICLE") ===
    (v3.eligibility.classification === "FULL_VEHICLE");
  results.push({
    case: definition.name,
    sourceType: definition.sourceType,
    expectedEligibility: definition.eligibility,
    actualEligibility: v3.eligibility.classification,
    tags: definition.tags,
    brand: definition.fixture?.brand ?? null,
    bodyStyle: definition.fixture?.bodyStyle ?? null,
    sourcePage: definition.fixture?.sourcePage ?? null,
    sourceLicense: definition.fixture?.license ?? null,
    exactEligibilityCorrect,
    automaticGateCorrect,
    eligibilityScore: v3.eligibility.score,
    eligibilityReasons: v3.eligibility.reasons,
    primarySelection: {
      candidateCount: v3.candidateCount,
      ambiguous: v3.ambiguous,
      selectedClass: v3.selected?.className ?? null,
      confidence: round(v3.selected?.confidence ?? 0),
      iou: selectionIoU === null ? null : round(selectionIoU),
      correct: target ? (selectionIoU ?? 0) >= 0.5 : null,
    },
    current: {
      ...roundedComparison(currentComparison),
      milliseconds: Math.round(currentMilliseconds),
      outputBytes: currentBytes.length,
    },
    v1: {
      ...roundedComparison(v1Comparison),
      milliseconds: Math.round(v1Milliseconds),
      outputBytes: v1.bytes.length,
      quality: v1.quality.rating,
    },
    v2: {
      ...roundedComparison(v2Comparison),
      milliseconds: Math.round(v2Milliseconds),
      outputBytes: v2.bytes?.length ?? 0,
      quality: v2.quality.rating,
    },
    v3: {
      ...roundedComparison(v3Comparison),
      milliseconds: Math.round(v3Milliseconds),
      outputBytes: v3.rawBytes?.length ?? 0,
      quality: v3.quality.rating,
      qualityScore: v3.quality.score,
      reasons: v3.quality.reasons,
      metrics: v3.quality.metrics,
    },
    v3Refined: {
      ...roundedComparison(v3RefinedComparison),
      outputBytes: v3.refinedBytes?.length ?? 0,
      selected: v3.metadata.refinementSelected,
    },
    isolatedMemory: {
      baselineBytes: v3.memory.rssBefore,
      peakSnapshotBytes: v3.memory.rssAfterInference,
      incrementalBytes: Math.max(0, v3.memory.rssAfterInference - v3.memory.rssBefore),
      afterReleaseBytes: v3.memory.rssAfterRelease,
    },
  });
  contactRows.push([
    await tile(source, `ORIGINAL ${definition.name}`),
    await tile(currentBytes, "CURRENT ISNET"),
    await tile(v1.bytes, `V1 ${v1.quality.rating}`),
    await tile(v2.bytes, `V2 ${v2.quality.rating}`),
    await tile(v3.bytes, `V3 ${v3.quality.rating}`),
    await maskTile(v3.bytes, `V3 MASK ${v3.quality.score}`),
  ]);
  console.log(
    `[vehicle-segmentation-v3] ${definition.name}: ${v3.eligibility.classification} / ${v3.quality.rating} / ${Math.round(v3Milliseconds)}ms`,
  );
}

await releaseVehicleSegmentationV2Runtime();
const groundTruthEligible = results.filter(
  (result) =>
    result.sourceType === "CONTROLLED_COCO_FIXTURE" &&
    result.expectedEligibility === "FULL_VEHICLE",
);
const eligible = results.filter((result) => result.expectedEligibility === "FULL_VEHICLE");
const metricSummary = (key) => {
  const values = (metric) =>
    groundTruthEligible.map((result) => result[key][metric]).filter(Number.isFinite);
  return {
    meanMaskIoU: round(mean(values("maskIoU"))),
    meanContamination: round(mean(values("contamination"))),
    meanMissingGeometry: round(mean(values("missingGeometry"))),
    meanMilliseconds: Math.round(
      mean(results.map((result) => result[key].milliseconds).filter(Number.isFinite)),
    ),
  };
};
const quality = {
  good: eligible.filter((result) => result.v3.quality === "good").length,
  needsReview: eligible.filter((result) => result.v3.quality === "needs_review").length,
  bad: eligible.filter((result) => result.v3.quality === "bad").length,
};
const memoryIncrements = results.map((result) => result.isolatedMemory.incrementalBytes);
const summary = {
  cases: results.length,
  realDealerShotCases: 0,
  controlledCocoCases: results.filter((result) => result.sourceType === "CONTROLLED_COCO_FIXTURE")
    .length,
  controlledLicensedBrandCases: results.filter(
    (result) => result.sourceType === "CONTROLLED_WIKIMEDIA_FIXTURE",
  ).length,
  fullVehicleCases: eligible.length,
  fullVehicleClassificationAccuracy: round(
    results.filter((result) => result.exactEligibilityCorrect).length / results.length,
  ),
  automaticFullVehicleGateAccuracy: round(
    results.filter((result) => result.automaticGateCorrect).length / results.length,
  ),
  primaryVehicleSelectionAccuracyOnGroundTruth: round(
    groundTruthEligible.filter((result) => result.primarySelection.correct).length /
      Math.max(1, groundTruthEligible.length),
  ),
  quality,
  qualityRates: {
    good: round(quality.good / Math.max(1, eligible.length)),
    needsReview: round(quality.needsReview / Math.max(1, eligible.length)),
    bad: round(quality.bad / Math.max(1, eligible.length)),
  },
  current: metricSummary("current"),
  v1: metricSummary("v1"),
  v2: metricSummary("v2"),
  v3: metricSummary("v3"),
  v3Refined: metricSummary("v3Refined"),
  v3ModelBytes: VEHICLE_SEGMENTATION_V3_ASSETS.reduce((total, asset) => total + asset.bytes, 0),
  isolatedIncrementalRssBytes: {
    mean: Math.round(mean(memoryIncrements)),
    maximumSnapshot: Math.max(...memoryIncrements),
  },
  promotionGateBlockedByMissingRealDealerShotMedia: true,
};

const tileWidth = 210;
const tileHeight = 166;
const sheet = sharp({
  create: {
    width: tileWidth * 6,
    height: tileHeight * contactRows.length,
    channels: 3,
    background: "#030712",
  },
});
const composites = [];
for (let row = 0; row < contactRows.length; row += 1) {
  for (let column = 0; column < contactRows[row].length; column += 1)
    composites.push({
      input: contactRows[row][column],
      left: column * tileWidth,
      top: row * tileHeight,
    });
}
const contactSheetPath = path.join(outputDirectory, "vehicle-segmentation-v3-contact-sheet.jpg");
await sheet.composite(composites).jpeg({ quality: 88 }).toFile(contactSheetPath);
const resultPath = path.join(outputDirectory, "vehicle-segmentation-v3-results.json");
await writeFile(
  resultPath,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
console.log(`[vehicle-segmentation-v3] results: ${resultPath}`);
console.log(`[vehicle-segmentation-v3] contact sheet: ${contactSheetPath}`);
