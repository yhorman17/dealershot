import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { createTransparentVehicleCutout } from "../worker/media.ts";
import {
  createVehicleAwareCutout,
  intersectionOverUnion,
  selectPrimaryVehicle,
} from "../worker/vehicle-aware-cutout.ts";

const cases = [
  { id: 194832, name: "dark_vehicle_low_light" },
  { id: 65485, name: "light_vehicle_outdoors" },
  { id: 172330, name: "secondary_vehicle_behind" },
  { id: 200839, name: "vehicle_with_people" },
  { id: 508602, name: "side_profile" },
  { id: 78823, name: "rear_three_quarter" },
  { id: 17178, name: "vehicle_near_edge" },
  { id: 23272, name: "reflective_glass_heavy" },
  { id: 33854, name: "ambiguous_multiple_vehicles" },
  { id: 493286, name: "partial_vehicle_detail_negative", expectedVehicle: false },
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const imageDirectory = argument("--images");
const annotationsPath = argument("--annotations");
const outputPath = argument("--output") ?? path.resolve("vehicle-aware-benchmark-results.json");
if (!imageDirectory || !annotationsPath) {
  throw new Error(
    "Usage: node scripts/benchmark-vehicle-aware-cutout.mjs --images <COCO val2017> --annotations <instances_val2017.json> [--output result.json]",
  );
}

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
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function annotationMask(annotation, width, height) {
  if (!Array.isArray(annotation.segmentation)) return null;
  const paths = annotation.segmentation
    .filter((polygon) => Array.isArray(polygon) && polygon.length >= 6)
    .map((polygon) => {
      let commands = `M ${polygon[0]} ${polygon[1]}`;
      for (let index = 2; index < polygon.length; index += 2) {
        commands += ` L ${polygon[index]} ${polygon[index + 1]}`;
      }
      return `${commands} Z`;
    });
  if (paths.length === 0) return null;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${paths.join(" ")}" fill="#fff" fill-rule="evenodd"/></svg>`,
  );
  const raw = await sharp(svg).removeAlpha().greyscale().raw().toBuffer();
  const mask = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) mask[index] = raw[index] >= 128 ? 1 : 0;
  return mask;
}

async function outputMask(bytes) {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) mask[index] = data[index] >= 64 ? 1 : 0;
  return { mask, width: info.width, height: info.height };
}

function compareMasks(predicted, expected) {
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
    maskIoU: union > 0 ? intersection / union : 0,
    contamination: predictedArea > 0 ? (predictedArea - intersection) / predictedArea : 0,
    missingGeometry: expectedArea > 0 ? (expectedArea - intersection) / expectedArea : 0,
  };
}

function targetAnnotation(caseDefinition, image) {
  if (caseDefinition.expectedVehicle === false) return null;
  const candidates = (annotations.get(caseDefinition.id) ?? [])
    .filter((annotation) => vehicleCategoryIds.has(annotation.category_id) && !annotation.iscrowd)
    .map((annotation) => ({
      annotation,
      detection: {
        box: {
          x: annotation.bbox[0],
          y: annotation.bbox[1],
          width: annotation.bbox[2],
          height: annotation.bbox[3],
        },
        confidence: 1,
        classId: annotation.category_id,
        className: "vehicle",
      },
    }));
  const selected = selectPrimaryVehicle(
    candidates.map((candidate) => candidate.detection),
    image.width,
    image.height,
  ).primary;
  return (
    candidates.find((candidate) => candidate.detection.box === selected?.box)?.annotation ?? null
  );
}

const initialRss = process.memoryUsage().rss;
let peakRss = initialRss;
const results = [];

// Warm both lazy sessions so latency numbers below represent steady-state jobs.
const warmImage = images.get(cases[0].id);
const warmBytes = await readFile(path.join(imageDirectory, warmImage.file_name));
await createTransparentVehicleCutout(warmBytes);
await createVehicleAwareCutout(warmBytes, createTransparentVehicleCutout);

for (const caseDefinition of cases) {
  const image = images.get(caseDefinition.id);
  if (!image) throw new Error(`COCO image metadata missing for ${caseDefinition.id}.`);
  const source = await readFile(path.join(imageDirectory, image.file_name));
  const target = targetAnnotation(caseDefinition, image);
  const expected = target ? await annotationMask(target, image.width, image.height) : null;

  const baselineStarted = performance.now();
  const baselineBytes = await createTransparentVehicleCutout(source);
  const baselineMs = performance.now() - baselineStarted;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const awareStarted = performance.now();
  const aware = await createVehicleAwareCutout(source, createTransparentVehicleCutout);
  const awareMs = performance.now() - awareStarted;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const baselineMask = await outputMask(baselineBytes);
  const awareMask = await outputMask(aware.bytes);
  const baselineComparison = expected
    ? compareMasks(baselineMask.mask, expected)
    : { maskIoU: null, contamination: null, missingGeometry: null };
  const awareComparison = expected
    ? compareMasks(awareMask.mask, expected)
    : { maskIoU: null, contamination: null, missingGeometry: null };
  const targetBox = target
    ? { x: target.bbox[0], y: target.bbox[1], width: target.bbox[2], height: target.bbox[3] }
    : null;
  const selectedBox = aware.detector.selected?.box ?? null;
  const selectionIoU = targetBox && selectedBox ? intersectionOverUnion(targetBox, selectedBox) : 0;
  const expectedVehicle = caseDefinition.expectedVehicle !== false;
  results.push({
    case: caseDefinition.name,
    cocoImageId: caseDefinition.id,
    expectedVehicle,
    detector: {
      candidateCount: aware.detector.candidateCount,
      selectedClass: aware.detector.selected?.className ?? null,
      confidence: round(aware.detector.selected?.confidence ?? 0),
      selectionIoU: round(selectionIoU),
      correct: expectedVehicle ? selectionIoU >= 0.5 : !selectedBox,
      ambiguous: aware.detector.ambiguous,
    },
    baseline: {
      ...Object.fromEntries(
        Object.entries(baselineComparison).map(([key, value]) => [
          key,
          typeof value === "number" ? round(value) : value,
        ]),
      ),
      milliseconds: Math.round(baselineMs),
      outputBytes: baselineBytes.length,
    },
    vehicleAware: {
      ...Object.fromEntries(
        Object.entries(awareComparison).map(([key, value]) => [
          key,
          typeof value === "number" ? round(value) : value,
        ]),
      ),
      milliseconds: Math.round(awareMs),
      outputBytes: aware.bytes.length,
      method: aware.method,
      quality: aware.quality.rating,
      qualityScore: aware.quality.score,
      reasons: aware.quality.reasons,
    },
  });
}

const positive = results.filter((result) => result.expectedVehicle);
const numeric = (side, key) =>
  positive.map((result) => result[side][key]).filter((value) => typeof value === "number");
const summary = {
  cases: results.length,
  detectorPrimaryAccuracy: round(
    results.filter((result) => result.detector.correct).length / results.length,
  ),
  quality: {
    good: results.filter((result) => result.vehicleAware.quality === "good").length,
    questionable: results.filter((result) => result.vehicleAware.quality === "questionable").length,
    bad: results.filter((result) => result.vehicleAware.quality === "bad").length,
  },
  baseline: {
    meanMaskIoU: round(mean(numeric("baseline", "maskIoU"))),
    meanContamination: round(mean(numeric("baseline", "contamination"))),
    meanMissingGeometry: round(mean(numeric("baseline", "missingGeometry"))),
    meanMilliseconds: Math.round(mean(results.map((result) => result.baseline.milliseconds))),
    meanOutputBytes: Math.round(mean(results.map((result) => result.baseline.outputBytes))),
  },
  vehicleAware: {
    meanMaskIoU: round(mean(numeric("vehicleAware", "maskIoU"))),
    meanContamination: round(mean(numeric("vehicleAware", "contamination"))),
    meanMissingGeometry: round(mean(numeric("vehicleAware", "missingGeometry"))),
    meanMilliseconds: Math.round(mean(results.map((result) => result.vehicleAware.milliseconds))),
    meanOutputBytes: Math.round(mean(results.map((result) => result.vehicleAware.outputBytes))),
  },
  peakRssIncreaseBytes: Math.max(0, peakRss - initialRss),
};

await writeFile(
  outputPath,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
console.log(`[vehicle-aware-benchmark] detailed results: ${outputPath}`);
