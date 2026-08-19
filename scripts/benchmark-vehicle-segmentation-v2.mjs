import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { createTransparentVehicleCutout } from "../worker/media.ts";
import { createVehicleAwareCutout, intersectionOverUnion } from "../worker/vehicle-aware-cutout.ts";
import {
  createVehicleSegmentationV2Cutout,
  detectVehicleInstances,
  releaseVehicleSegmentationV2Runtime,
  renderVehicleMaskCutout,
  selectPrimaryVehicleInstance,
} from "../worker/vehicle-segmentation-v2.ts";

const cases = [
  { id: 228942, name: "dark_vehicle_night", eligibility: "FULL_VEHICLE" },
  { id: 354829, name: "light_vehicle_overhead", eligibility: "FULL_VEHICLE" },
  { id: 338718, name: "side_profile_suv", eligibility: "FULL_VEHICLE" },
  { id: 543043, name: "red_vehicle_outdoors", eligibility: "FULL_VEHICLE" },
  { id: 263594, name: "light_vehicle_lot", eligibility: "FULL_VEHICLE" },
  { id: 138979, name: "rear_vehicle_with_bus", eligibility: "FULL_VEHICLE" },
  { id: 442456, name: "person_near_vehicle", eligibility: "FULL_VEHICLE" },
  { id: 493286, name: "antique_side_profile", eligibility: "FULL_VEHICLE" },
  { id: 78823, name: "rear_three_quarter_with_dog", eligibility: "FULL_VEHICLE" },
  { id: 200839, name: "bus_exterior", eligibility: "FULL_VEHICLE" },
  { id: 97679, name: "similar_multiple_vehicles", eligibility: "AMBIGUOUS" },
  { id: 194832, name: "vehicle_interior_negative", eligibility: "NON_VEHICLE" },
  { id: 17178, name: "partial_vehicle_edge_negative", eligibility: "PARTIAL_VEHICLE" },
  { id: 23272, name: "hood_glass_detail_negative", eligibility: "PARTIAL_VEHICLE" },
  { id: 508602, name: "roof_detail_negative", eligibility: "PARTIAL_VEHICLE" },
  { id: 107087, name: "windshield_detail_negative", eligibility: "PARTIAL_VEHICLE" },
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const imageDirectory = argument("--images");
const annotationsPath = argument("--annotations");
const outputDirectory =
  argument("--output-directory") ?? path.resolve("vehicle-segmentation-v2-benchmark");
if (!imageDirectory || !annotationsPath) {
  throw new Error(
    "Usage: node scripts/benchmark-vehicle-segmentation-v2.mjs --images <COCO images> --annotations <instances_val2017.json> [--output-directory path]",
  );
}

await mkdir(outputDirectory, { recursive: true });
const coco = JSON.parse(await readFile(annotationsPath, "utf8"));
const images = new Map(coco.images.map((image) => [image.id, image]));
const annotations = new Map();
for (const annotation of coco.annotations) {
  const list = annotations.get(annotation.image_id) ?? [];
  list.push(annotation);
  annotations.set(annotation.image_id, list);
}
const vehicleCategoryIds = new Set([3, 6, 8]);

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function annotationMask(annotation, width, height) {
  if (!Array.isArray(annotation?.segmentation)) return null;
  const paths = annotation.segmentation
    .filter((polygon) => Array.isArray(polygon) && polygon.length >= 6)
    .map((polygon) => {
      let commands = `M ${polygon[0]} ${polygon[1]}`;
      for (let index = 2; index < polygon.length; index += 2) {
        commands += ` L ${polygon[index]} ${polygon[index + 1]}`;
      }
      return `${commands} Z`;
    });
  if (!paths.length) return null;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${paths.join(" ")}" fill="#fff" fill-rule="evenodd"/></svg>`,
  );
  const raw = await sharp(svg).removeAlpha().greyscale().raw().toBuffer();
  return Uint8Array.from(raw, (value) => (value >= 128 ? 1 : 0));
}

async function outputMask(bytes) {
  if (!bytes) return null;
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    mask: Uint8Array.from(data, (value) => (value >= 64 ? 1 : 0)),
    width: info.width,
    height: info.height,
  };
}

function compareMasks(predicted, expected) {
  if (!predicted || !expected) {
    return { maskIoU: null, contamination: null, missingGeometry: null };
  }
  let predictedArea = 0;
  let expectedArea = 0;
  let intersection = 0;
  for (let index = 0; index < predicted.length; index += 1) {
    predictedArea += predicted[index];
    expectedArea += expected[index];
    intersection += predicted[index] && expected[index] ? 1 : 0;
  }
  const union = predictedArea + expectedArea - intersection;
  return {
    maskIoU: union ? intersection / union : 0,
    contamination: predictedArea ? (predictedArea - intersection) / predictedArea : 0,
    missingGeometry: expectedArea ? (expectedArea - intersection) / expectedArea : 0,
  };
}

function targetAnnotation(definition, image) {
  if (definition.eligibility !== "FULL_VEHICLE") return null;
  const candidates = (annotations.get(definition.id) ?? []).filter(
    (annotation) => vehicleCategoryIds.has(annotation.category_id) && !annotation.iscrowd,
  );
  return (
    candidates
      .map((annotation) => {
        const [x, y, width, height] = annotation.bbox;
        const area = width * height;
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        const centerDistance = Math.hypot(centerX - image.width / 2, centerY - image.height / 2);
        const center =
          1 - Math.min(1, centerDistance / Math.hypot(image.width / 2, image.height / 2));
        return {
          annotation,
          rank: Math.sqrt(area / (image.width * image.height)) * (0.65 + center * 0.35),
        };
      })
      .sort((left, right) => right.rank - left.rank)[0]?.annotation ?? null
  );
}

async function tile(bytes, title, width = 220, height = 145) {
  const label = Buffer.from(
    `<svg width="${width}" height="28"><rect width="100%" height="100%" fill="#111827"/><text x="8" y="19" fill="#f9fafb" font-size="12" font-family="Arial">${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</text></svg>`,
  );
  let image;
  if (bytes) {
    image = await sharp(bytes)
      .resize(width, height, { fit: "contain", background: "#d1d5db" })
      .flatten({ background: "#d1d5db" })
      .png()
      .toBuffer();
  } else {
    image = await sharp({ create: { width, height, channels: 3, background: "#374151" } })
      .png()
      .toBuffer();
  }
  return sharp({ create: { width, height: height + 28, channels: 3, background: "#111827" } })
    .composite([
      { input: image, left: 0, top: 0 },
      { input: label, left: 0, top: height },
    ])
    .png()
    .toBuffer();
}

async function maskTile(bytes, title, width = 220, height = 145) {
  if (!bytes) return tile(null, title, width, height);
  const mask = await sharp(bytes).ensureAlpha().extractChannel(3).png().toBuffer();
  return tile(mask, title, width, height);
}

const initialRss = process.memoryUsage().rss;
let peakRss = initialRss;
const results = [];
const contactRows = [];

for (const definition of cases) {
  const image = images.get(definition.id);
  if (!image) throw new Error(`COCO metadata missing for ${definition.id}.`);
  const source = await readFile(path.join(imageDirectory, image.file_name));
  const target = targetAnnotation(definition, image);
  const expectedMask = target ? await annotationMask(target, image.width, image.height) : null;
  const targetBox = target
    ? { x: target.bbox[0], y: target.bbox[1], width: target.bbox[2], height: target.bbox[3] }
    : null;

  const currentStarted = performance.now();
  const currentBytes = await createTransparentVehicleCutout(source);
  const currentMilliseconds = performance.now() - currentStarted;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const v1Started = performance.now();
  const v1 = await createVehicleAwareCutout(source, createTransparentVehicleCutout);
  const v1Milliseconds = performance.now() - v1Started;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const v2Started = performance.now();
  const instances = await detectVehicleInstances(source);
  const selection = selectPrimaryVehicleInstance(instances, image.width, image.height);
  const v2 = await createVehicleSegmentationV2Cutout(source, async () => instances);
  const v2Milliseconds = performance.now() - v2Started;
  const rawBytes =
    selection.primary && v2.eligibility.classification === "FULL_VEHICLE"
      ? await renderVehicleMaskCutout(source, selection.primary.mask, image.width, image.height)
      : null;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const currentComparison = compareMasks((await outputMask(currentBytes))?.mask, expectedMask);
  const v1Comparison = compareMasks((await outputMask(v1.bytes))?.mask, expectedMask);
  const rawComparison = compareMasks((await outputMask(rawBytes))?.mask, expectedMask);
  const refinedComparison = compareMasks((await outputMask(v2.bytes))?.mask, expectedMask);
  const selectedBox = v2.selected?.box ?? null;
  const selectionIoU =
    targetBox && selectedBox ? intersectionOverUnion(targetBox, selectedBox) : null;
  const exactEligibilityCorrect = v2.eligibility.classification === definition.eligibility;
  const autoGateCorrect =
    (definition.eligibility === "FULL_VEHICLE") ===
    (v2.eligibility.classification === "FULL_VEHICLE");
  const reviewScores = expectedMask
    ? {
        vehicleCompleteness: Math.max(1, Math.round((1 - refinedComparison.missingGeometry) * 5)),
        edgeQuality: Math.max(
          1,
          Math.round(
            (refinedComparison.maskIoU * 0.6 + (1 - refinedComparison.contamination) * 0.4) * 5,
          ),
        ),
        glassQuality: Math.max(1, Math.round((1 - v2.quality.metrics.upperBodyHoleRatio * 8) * 5)),
        backgroundIsolation: Math.max(1, Math.round((1 - refinedComparison.contamination) * 5)),
      }
    : null;
  results.push({
    case: definition.name,
    source: "CONTROLLED_COCO_FIXTURE",
    cocoImageId: definition.id,
    expectedEligibility: definition.eligibility,
    actualEligibility: v2.eligibility.classification,
    exactEligibilityCorrect,
    autoGateCorrect,
    eligibilityScore: v2.eligibility.score,
    eligibilityReasons: v2.eligibility.reasons,
    primarySelection: {
      candidateCount: v2.candidateCount,
      ambiguous: v2.ambiguous,
      selectedClass: v2.selected?.className ?? null,
      confidence: round(v2.selected?.confidence ?? 0),
      iou: selectionIoU === null ? null : round(selectionIoU),
      correct: definition.eligibility === "FULL_VEHICLE" ? (selectionIoU ?? 0) >= 0.5 : null,
    },
    current: {
      ...Object.fromEntries(
        Object.entries(currentComparison).map(([key, value]) => [
          key,
          value === null ? null : round(value),
        ]),
      ),
      milliseconds: Math.round(currentMilliseconds),
      outputBytes: currentBytes.length,
    },
    v1: {
      ...Object.fromEntries(
        Object.entries(v1Comparison).map(([key, value]) => [
          key,
          value === null ? null : round(value),
        ]),
      ),
      milliseconds: Math.round(v1Milliseconds),
      outputBytes: v1.bytes.length,
      quality: v1.quality.rating,
    },
    v2: {
      ...Object.fromEntries(
        Object.entries(rawComparison).map(([key, value]) => [
          key,
          value === null ? null : round(value),
        ]),
      ),
      milliseconds: Math.round(v2Milliseconds),
      outputBytes: rawBytes?.length ?? 0,
    },
    v2Refined: {
      ...Object.fromEntries(
        Object.entries(refinedComparison).map(([key, value]) => [
          key,
          value === null ? null : round(value),
        ]),
      ),
      outputBytes: v2.bytes?.length ?? 0,
      quality: v2.quality.rating,
      qualityScore: v2.quality.score,
      reasons: v2.quality.reasons,
      metrics: v2.quality.metrics,
    },
    reviewScores,
  });

  const row = [
    await tile(source, `ORIGINAL ${definition.name}`),
    await tile(currentBytes, "CURRENT ISNET"),
    await tile(v1.bytes, `V1 ${v1.quality.rating.toUpperCase()}`),
    await tile(rawBytes, `V2 RAW ${v2.eligibility.classification}`),
    await tile(v2.bytes, `V2 REFINED ${v2.quality.rating.toUpperCase()}`),
    await maskTile(v2.bytes, `MASK ${v2.quality.score}`),
  ];
  contactRows.push(row);
  console.log(
    `[vehicle-segmentation-v2] ${definition.name}: ${v2.eligibility.classification} / ${v2.quality.rating}`,
  );
}

await releaseVehicleSegmentationV2Runtime();
if (global.gc) global.gc();
await new Promise((resolve) => setTimeout(resolve, 100));
const rssAfterRelease = process.memoryUsage().rss;

const eligible = results.filter((result) => result.expectedEligibility === "FULL_VEHICLE");
function pipelineSummary(key) {
  const values = (metric) =>
    eligible.map((result) => result[key][metric]).filter((value) => typeof value === "number");
  return {
    meanMaskIoU: round(mean(values("maskIoU"))),
    meanContamination: round(mean(values("contamination"))),
    meanMissingGeometry: round(mean(values("missingGeometry"))),
    meanOutputBytes: Math.round(mean(values("outputBytes"))),
  };
}
const qualityCounts = {
  good: eligible.filter((result) => result.v2Refined.quality === "good").length,
  needsReview: eligible.filter((result) => result.v2Refined.quality === "needs_review").length,
  bad: eligible.filter((result) => result.v2Refined.quality === "bad").length,
};
const summary = {
  cases: results.length,
  eligibleCases: eligible.length,
  realDealerShotCases: 0,
  controlledFixtureCases: results.length,
  primaryCompleteVehicleSelectionAccuracy: round(
    eligible.filter((result) => result.primarySelection.correct).length /
      Math.max(1, eligible.length),
  ),
  exactEligibilityAccuracy: round(
    results.filter((result) => result.exactEligibilityCorrect).length / results.length,
  ),
  automaticEligibilityGateAccuracy: round(
    results.filter((result) => result.autoGateCorrect).length / results.length,
  ),
  quality: qualityCounts,
  current: pipelineSummary("current"),
  v1: pipelineSummary("v1"),
  v2: pipelineSummary("v2"),
  v2Refined: pipelineSummary("v2Refined"),
  v2MeanMilliseconds: Math.round(mean(results.map((result) => result.v2.milliseconds))),
  combinedBenchmarkPeakRssIncreaseBytes: Math.max(0, peakRss - initialRss),
  rssAfterV2ReleaseBytes: rssAfterRelease,
};

const tileWidth = 220;
const tileHeight = 173;
const contactSheet = sharp({
  create: {
    width: tileWidth * 6,
    height: tileHeight * contactRows.length,
    channels: 3,
    background: "#030712",
  },
});
const composites = [];
for (let row = 0; row < contactRows.length; row += 1) {
  for (let column = 0; column < contactRows[row].length; column += 1) {
    composites.push({
      input: contactRows[row][column],
      left: column * tileWidth,
      top: row * tileHeight,
    });
  }
}
const contactSheetPath = path.join(outputDirectory, "vehicle-segmentation-v2-contact-sheet.jpg");
await contactSheet.composite(composites).jpeg({ quality: 88 }).toFile(contactSheetPath);
const resultPath = path.join(outputDirectory, "vehicle-segmentation-v2-results.json");
await writeFile(
  resultPath,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
console.log(`[vehicle-segmentation-v2] results: ${resultPath}`);
console.log(`[vehicle-segmentation-v2] contact sheet: ${contactSheetPath}`);
