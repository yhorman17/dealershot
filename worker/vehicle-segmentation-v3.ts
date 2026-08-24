import { access, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  refineAutomotiveMask,
  renderVehicleMaskCutout,
  type BoundingBox,
} from "./vehicle-segmentation-v2.ts";

export const VEHICLE_SEGMENTATION_V3_PIPELINE = "rtdetrv2-mobilesam-full-vehicle-v3";
export const VEHICLE_SEGMENTATION_V3_MODELS = Object.freeze({
  detector: "RT-DETRv2 R18vd COCO @ 640",
  segmenter: "MobileSAM ViT-T box prompt @ 1024 / 256 mask logits",
});

export type VehicleEligibility = "FULL_VEHICLE" | "PARTIAL_VEHICLE" | "AMBIGUOUS" | "NON_VEHICLE";
export type VehicleSegmentationQuality = "good" | "needs_review" | "bad";

export type VehicleDetection = {
  box: BoundingBox;
  confidence: number;
  classId: number;
  className: "car" | "bus" | "truck";
  rank?: number;
};

export type FullVehicleEligibility = {
  classification: VehicleEligibility;
  score: number;
  reasons: string[];
  metrics: {
    confidence: number;
    boxAreaRatio: number;
    widthRatio: number;
    heightRatio: number;
    aspectRatio: number;
    centerProximity: number;
    edgeContacts: number;
    oppositeEdgeContact: boolean;
  };
};

export type VehicleSegmentationV3Result = {
  bytes: Buffer | null;
  rawBytes: Buffer | null;
  refinedBytes: Buffer | null;
  eligibility: FullVehicleEligibility;
  selected: VehicleDetection | null;
  candidateCount: number;
  ambiguous: boolean;
  quality: {
    rating: VehicleSegmentationQuality;
    score: number;
    reasons: string[];
    metrics: {
      predictorScore: number;
      maskAreaRatio: number;
      maskBoxFill: number;
      detectorCoverage: number;
      outsidePaddedBoxRatio: number;
      centerOccupancy: number;
      primaryComponentRatio: number;
      disconnectedComponentRatio: number;
      upperBodyHoleRatio: number;
    };
  };
  metadata: {
    pipeline: string;
    detector: string;
    segmenter: string;
    method: "detector_box_prompted_segmentation";
    maskResolution: 256;
    refinementSelected: boolean;
    framing: { recommendedVehicleWidthRatio: number } | null;
  };
};

type Segmentation = {
  mask: Uint8Array;
  predictorScore: number;
  maskIndex: number;
};

type DetectorRuntime = {
  ort: typeof import("onnxruntime-node");
  detector: import("onnxruntime-node").InferenceSession;
};

type SegmenterRuntime = {
  ort: typeof import("onnxruntime-node");
  encoder: import("onnxruntime-node").InferenceSession;
  decoder: import("onnxruntime-node").InferenceSession;
};

const VEHICLE_LABELS = new Map<number, VehicleDetection["className"]>([
  [2, "car"],
  [5, "bus"],
  [7, "truck"],
]);
const DETECTOR_SCORE_THRESHOLD = 0.25;
const DETECTOR_NMS_THRESHOLD = 0.68;
const MAX_DETECTIONS = 8;
const SAM_SIZE = 1024;
let detectorRuntimePromise: Promise<DetectorRuntime> | null = null;
let segmenterRuntimePromise: Promise<SegmenterRuntime> | null = null;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function boxArea(box: BoundingBox) {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function intersectionArea(left: BoundingBox, right: BoundingBox) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function boxIoU(left: BoundingBox, right: BoundingBox) {
  const intersection = intersectionArea(left, right);
  return intersection / Math.max(1, boxArea(left) + boxArea(right) - intersection);
}

function centerProximity(box: BoundingBox, width: number, height: number) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const distance = Math.hypot(x - width / 2, y - height / 2);
  return 1 - clamp(distance / Math.hypot(width / 2, height / 2), 0, 1);
}

function edgeRelationship(box: BoundingBox, width: number, height: number) {
  const toleranceX = Math.max(3, width * 0.012);
  const toleranceY = Math.max(3, height * 0.012);
  const left = box.x <= toleranceX;
  const top = box.y <= toleranceY;
  const right = box.x + box.width >= width - toleranceX;
  const bottom = box.y + box.height >= height - toleranceY;
  return {
    count: [left, top, right, bottom].filter(Boolean).length,
    opposite: (left && right) || (top && bottom),
  };
}

function nonMaximumSuppression(detections: VehicleDetection[]) {
  const kept: VehicleDetection[] = [];
  for (const candidate of [...detections].sort((a, b) => b.confidence - a.confidence)) {
    if (kept.some((existing) => boxIoU(existing.box, candidate.box) >= DETECTOR_NMS_THRESHOLD))
      continue;
    kept.push(candidate);
    if (kept.length >= MAX_DETECTIONS) break;
  }
  return kept;
}

export function selectPrimaryVehicle(
  detections: VehicleDetection[],
  width: number,
  height: number,
) {
  const imageArea = width * height;
  const ranked = detections
    .map((detection) => {
      const areaRatio = boxArea(detection.box) / imageArea;
      const proximity = centerProximity(detection.box, width, height);
      const edges = edgeRelationship(detection.box, width, height);
      const completeness = clamp(1 - edges.count * 0.13 - (edges.opposite ? 0.32 : 0), 0, 1);
      const rank =
        detection.confidence *
        Math.sqrt(Math.max(areaRatio, 0.0001)) *
        (0.42 + proximity * 0.36 + completeness * 0.22);
      return { ...detection, rank };
    })
    .sort((left, right) => (right.rank ?? 0) - (left.rank ?? 0));
  const primary = ranked[0] ?? null;
  const secondary = ranked[1] ?? null;
  const ambiguous = Boolean(
    primary &&
    secondary &&
    (secondary.rank ?? 0) >= (primary.rank ?? 0) * 0.82 &&
    boxArea(secondary.box) >= boxArea(primary.box) * 0.62,
  );
  return { primary, ranked, ambiguous };
}

export function classifyFullVehicleGeometry(input: {
  detection: VehicleDetection | null;
  width: number;
  height: number;
  ambiguous: boolean;
}): FullVehicleEligibility {
  const { detection, width, height } = input;
  if (!detection) {
    return {
      classification: "NON_VEHICLE",
      score: 0,
      reasons: ["no_vehicle_detection"],
      metrics: {
        confidence: 0,
        boxAreaRatio: 0,
        widthRatio: 0,
        heightRatio: 0,
        aspectRatio: 0,
        centerProximity: 0,
        edgeContacts: 0,
        oppositeEdgeContact: false,
      },
    };
  }
  const areaRatio = boxArea(detection.box) / (width * height);
  const widthRatio = detection.box.width / width;
  const heightRatio = detection.box.height / height;
  const aspectRatio = detection.box.width / Math.max(1, detection.box.height);
  const proximity = centerProximity(detection.box, width, height);
  const edges = edgeRelationship(detection.box, width, height);
  const reasons: string[] = [];
  if (input.ambiguous) reasons.push("multiple_plausible_complete_vehicles");
  if (areaRatio < 0.035) reasons.push("vehicle_too_small_for_primary_exterior");
  if (heightRatio < 0.16) reasons.push("insufficient_vehicle_height");
  if (aspectRatio < 0.78 || aspectRatio > 5.4) reasons.push("implausible_full_vehicle_aspect");
  if (areaRatio > 0.9) reasons.push("vehicle_fills_frame_like_partial_detail");
  if (edges.opposite || (edges.count >= 2 && areaRatio >= 0.34))
    reasons.push("vehicle_geometry_clipped_by_frame");
  if (detection.confidence < 0.34) reasons.push("low_vehicle_detection_confidence");
  const score = round(
    detection.confidence * 0.34 +
      clamp((areaRatio - 0.03) / 0.3, 0, 1) * 0.23 +
      clamp(heightRatio / 0.42, 0, 1) * 0.14 +
      proximity * 0.12 +
      clamp(1 - edges.count * 0.2 - (edges.opposite ? 0.35 : 0), 0, 1) * 0.17,
  );
  let classification: VehicleEligibility;
  if (input.ambiguous) classification = "AMBIGUOUS";
  else if (
    reasons.includes("vehicle_fills_frame_like_partial_detail") ||
    reasons.includes("vehicle_geometry_clipped_by_frame") ||
    reasons.includes("implausible_full_vehicle_aspect")
  )
    classification = "PARTIAL_VEHICLE";
  else if (reasons.includes("vehicle_too_small_for_primary_exterior"))
    classification = areaRatio < 0.015 ? "NON_VEHICLE" : "AMBIGUOUS";
  else if (score >= 0.62 && reasons.length === 0) classification = "FULL_VEHICLE";
  else classification = "AMBIGUOUS";
  return {
    classification,
    score,
    reasons,
    metrics: {
      confidence: round(detection.confidence),
      boxAreaRatio: round(areaRatio),
      widthRatio: round(widthRatio),
      heightRatio: round(heightRatio),
      aspectRatio: round(aspectRatio),
      centerProximity: round(proximity),
      edgeContacts: edges.count,
      oppositeEdgeContact: edges.opposite,
    },
  };
}

async function assetDirectory() {
  const candidates = [
    process.env.DEALERSHOT_V3_MODEL_DIR,
    path.resolve(process.cwd(), "worker-assets/vehicle-segmentation-v3"),
    path.resolve(process.cwd(), ".output/public/vehicle-segmentation-v3"),
    path.resolve(process.cwd(), "public/vehicle-segmentation-v3"),
    path.resolve(process.env.TEMP ?? process.cwd(), "dealershot-v3-models"),
  ];
  for (const candidate of candidates.filter((candidate): candidate is string =>
    Boolean(candidate),
  )) {
    try {
      await Promise.all([
        access(path.join(candidate, "rtdetrv2-r18vd-coco.onnx")),
        access(path.join(candidate, "rtdetrv2-r18vd-coco.onnx.data")),
        access(path.join(candidate, "mobile-sam-vit-t-encoder.onnx")),
        access(path.join(candidate, "mobile-sam-vit-t-decoder.onnx")),
      ]);
      return candidate;
    } catch {
      // Assets are prepared only by the explicit experiment command.
    }
  }
  throw new Error("vehicle_segmentation_v3_assets_unavailable");
}

const runtimeOptions = {
  executionProviders: ["cpu"] as const,
  graphOptimizationLevel: "all" as const,
  executionMode: "sequential" as const,
  enableCpuMemArena: false,
  enableMemPattern: false,
  interOpNumThreads: 1,
};

async function detectorRuntime() {
  detectorRuntimePromise ??= (async () => {
    const [ort, directory] = await Promise.all([import("onnxruntime-node"), assetDirectory()]);
    const detector = await ort.InferenceSession.create(
      path.join(directory, "rtdetrv2-r18vd-coco.onnx"),
      runtimeOptions,
    );
    return { ort, detector };
  })();
  return detectorRuntimePromise;
}

async function segmenterRuntime() {
  segmenterRuntimePromise ??= (async () => {
    const [ort, directory] = await Promise.all([import("onnxruntime-node"), assetDirectory()]);
    const [encoder, decoder] = await Promise.all([
      ort.InferenceSession.create(
        path.join(directory, "mobile-sam-vit-t-encoder.onnx"),
        runtimeOptions,
      ),
      ort.InferenceSession.create(
        path.join(directory, "mobile-sam-vit-t-decoder.onnx"),
        runtimeOptions,
      ),
    ]);
    return { ort, encoder, decoder };
  })();
  return segmenterRuntimePromise;
}

export async function releaseVehicleSegmentationV3Runtime() {
  const detectorPending = detectorRuntimePromise;
  const segmenterPending = segmenterRuntimePromise;
  detectorRuntimePromise = null;
  segmenterRuntimePromise = null;
  const releases: Promise<unknown>[] = [];
  if (detectorPending) releases.push(detectorPending.then((loaded) => loaded.detector.release()));
  if (segmenterPending)
    releases.push(
      segmenterPending.then((loaded) =>
        Promise.all([loaded.encoder.release(), loaded.decoder.release()]),
      ),
    );
  await Promise.all(releases);
}

export async function detectVehicles(original: Buffer): Promise<VehicleDetection[]> {
  const metadata = await sharp(original, { failOn: "warning" }).rotate().metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("vehicle_segmentation_v3_source_invalid");
  const { data } = await sharp(original, { failOn: "warning" })
    .rotate()
    .resize(640, 640, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = 640 * 640;
  const pixels = new Float32Array(plane * 3);
  for (let pixel = 0; pixel < plane; pixel += 1) {
    pixels[pixel] = data[pixel * 3] / 255;
    pixels[pixel + plane] = data[pixel * 3 + 1] / 255;
    pixels[pixel + plane * 2] = data[pixel * 3 + 2] / 255;
  }
  const loaded = await detectorRuntime();
  const outputs = await loaded.detector.run({
    images: new loaded.ort.Tensor("float32", pixels, [1, 3, 640, 640]),
    orig_target_sizes: new loaded.ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(metadata.width), BigInt(metadata.height)]),
      [1, 2],
    ),
  });
  const labels = outputs.labels;
  const boxes = outputs.boxes;
  const scores = outputs.scores;
  if (!labels || !boxes || !scores)
    throw new Error("vehicle_segmentation_v3_detector_output_invalid");
  const detections: VehicleDetection[] = [];
  for (let index = 0; index < labels.data.length; index += 1) {
    const classId = Number(labels.data[index]);
    const confidence = Number(scores.data[index]);
    const className = VEHICLE_LABELS.get(classId);
    if (!className || confidence < DETECTOR_SCORE_THRESHOLD) continue;
    const offset = index * 4;
    const left = clamp(Number(boxes.data[offset]), 0, metadata.width - 1);
    const top = clamp(Number(boxes.data[offset + 1]), 0, metadata.height - 1);
    const right = clamp(Number(boxes.data[offset + 2]), left + 1, metadata.width);
    const bottom = clamp(Number(boxes.data[offset + 3]), top + 1, metadata.height);
    detections.push({
      box: { x: left, y: top, width: right - left, height: bottom - top },
      confidence,
      classId,
      className,
    });
  }
  return nonMaximumSuppression(detections);
}

async function segmentWithMobileSam(original: Buffer, box: BoundingBox): Promise<Segmentation> {
  const metadata = await sharp(original, { failOn: "warning" }).rotate().metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("vehicle_segmentation_v3_source_invalid");
  const scale = SAM_SIZE / Math.max(metadata.width, metadata.height);
  const resizedWidth = Math.max(1, Math.round(metadata.width * scale));
  const resizedHeight = Math.max(1, Math.round(metadata.height * scale));
  const { data } = await sharp(original, { failOn: "warning" })
    .rotate()
    .resize(resizedWidth, resizedHeight, { fit: "fill" })
    .removeAlpha()
    .extend({
      right: SAM_SIZE - resizedWidth,
      bottom: SAM_SIZE - resizedHeight,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = SAM_SIZE * SAM_SIZE;
  const pixels = new Float32Array(plane * 3);
  const means = [123.675, 116.28, 103.53];
  const standardDeviations = [58.395, 57.12, 57.375];
  for (let pixel = 0; pixel < plane; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      pixels[pixel + channel * plane] =
        (data[pixel * 3 + channel] - means[channel]) / standardDeviations[channel];
    }
  }
  const loaded = await segmenterRuntime();
  const encoded = await loaded.encoder.run({
    image: new loaded.ort.Tensor("float32", pixels, [1, 3, SAM_SIZE, SAM_SIZE]),
  });
  const embeddings = encoded.image_embeddings;
  if (!embeddings) throw new Error("vehicle_segmentation_v3_encoder_output_invalid");
  const pointCoordinates = Float32Array.from([
    box.x * scale,
    box.y * scale,
    (box.x + box.width) * scale,
    (box.y + box.height) * scale,
  ]);
  const decoded = await loaded.decoder.run({
    image_embeddings: embeddings,
    point_coords: new loaded.ort.Tensor("float32", pointCoordinates, [1, 2, 2]),
    point_labels: new loaded.ort.Tensor("float32", Float32Array.from([2, 3]), [1, 2]),
    mask_input: new loaded.ort.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new loaded.ort.Tensor("float32", Float32Array.from([0]), [1]),
    orig_im_size: new loaded.ort.Tensor(
      "float32",
      Float32Array.from([metadata.height, metadata.width]),
      [2],
    ),
  });
  const masks = decoded.masks;
  const predictions = decoded.iou_predictions;
  if (!masks || !predictions || masks.dims.length !== 4)
    throw new Error("vehicle_segmentation_v3_decoder_output_invalid");
  const maskCount = masks.dims[1];
  const maskPixels = metadata.width * metadata.height;
  let best: Segmentation | null = null;
  for (let maskIndex = maskCount > 1 ? 1 : 0; maskIndex < maskCount; maskIndex += 1) {
    const mask = new Uint8Array(maskPixels);
    const start = maskIndex * maskPixels;
    let area = 0;
    let inside = 0;
    for (let index = 0; index < maskPixels; index += 1) {
      if (Number(masks.data[start + index]) <= 0) continue;
      mask[index] = 1;
      area += 1;
      const x = index % metadata.width;
      const y = Math.floor(index / metadata.width);
      if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height)
        inside += 1;
    }
    const predictorScore = Number(predictions.data[maskIndex]);
    const selectionScore = predictorScore + (inside / Math.max(1, area)) * 0.16;
    if (!best || selectionScore > best.predictorScore) {
      best = { mask, predictorScore: selectionScore, maskIndex };
    }
  }
  if (!best) throw new Error("vehicle_segmentation_v3_empty_mask_output");
  best.predictorScore = Number(predictions.data[best.maskIndex]);
  return best;
}

function maskMetrics(mask: Uint8Array, width: number, height: number, box: BoundingBox) {
  const paddingX = box.width * 0.06;
  const paddingY = box.height * 0.08;
  const padded = {
    x: Math.max(0, box.x - paddingX),
    y: Math.max(0, box.y - paddingY),
    width: Math.min(width, box.x + box.width + paddingX) - Math.max(0, box.x - paddingX),
    height: Math.min(height, box.y + box.height + paddingY) - Math.max(0, box.y - paddingY),
  };
  let area = 0;
  let insideDetector = 0;
  let outsidePadded = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const center = {
    x1: Math.floor(box.x + box.width * 0.3),
    x2: Math.ceil(box.x + box.width * 0.7),
    y1: Math.floor(box.y + box.height * 0.3),
    y2: Math.ceil(box.y + box.height * 0.7),
  };
  let centerPixels = 0;
  let centerForeground = 0;
  for (let index = 0; index < mask.length; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (x >= center.x1 && x < center.x2 && y >= center.y1 && y < center.y2) {
      centerPixels += 1;
      if (mask[index]) centerForeground += 1;
    }
    if (!mask[index]) continue;
    area += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height)
      insideDetector += 1;
    if (x < padded.x || x > padded.x + padded.width || y < padded.y || y > padded.y + padded.height)
      outsidePadded += 1;
  }
  const boundsArea = area ? (maxX - minX + 1) * (maxY - minY + 1) : 0;
  return {
    area,
    maskAreaRatio: area / (width * height),
    maskBoxFill: area / Math.max(1, boundsArea),
    detectorCoverage: insideDetector / Math.max(1, boxArea(box)),
    outsidePaddedBoxRatio: outsidePadded / Math.max(1, area),
    centerOccupancy: centerForeground / Math.max(1, centerPixels),
  };
}

export function scoreVehicleMask(input: {
  mask: Uint8Array;
  width: number;
  height: number;
  detection: VehicleDetection;
  eligibility: FullVehicleEligibility;
  predictorScore: number;
  refinement: ReturnType<typeof refineAutomotiveMask>;
}) {
  const metrics = maskMetrics(input.mask, input.width, input.height, input.detection.box);
  const reasons: string[] = [];
  if (metrics.detectorCoverage < 0.32) reasons.push("missing_vehicle_geometry");
  if (metrics.outsidePaddedBoxRatio > 0.08) reasons.push("background_contamination");
  if (metrics.centerOccupancy < 0.58) reasons.push("missing_vehicle_center_mass");
  if (metrics.maskBoxFill < 0.3) reasons.push("fragmented_vehicle_silhouette");
  if (input.refinement.disconnectedComponentRatio > 0.045)
    reasons.push("unrelated_disconnected_components");
  if (input.refinement.upperBodyHoleRatio > 0.05) reasons.push("glass_or_body_holes_excessive");
  const score = round(
    input.eligibility.score * 0.2 +
      clamp(input.predictorScore, 0, 1) * 0.18 +
      clamp(metrics.detectorCoverage / 0.58, 0, 1) * 0.17 +
      clamp(1 - metrics.outsidePaddedBoxRatio * 6, 0, 1) * 0.16 +
      metrics.centerOccupancy * 0.12 +
      clamp(metrics.maskBoxFill / 0.58, 0, 1) * 0.09 +
      input.refinement.primaryComponentRatio * 0.08,
  );
  let rating: VehicleSegmentationQuality;
  if (input.eligibility.classification !== "FULL_VEHICLE") rating = "bad";
  else if (score >= 0.78 && reasons.length === 0) rating = "good";
  else if (score >= 0.56) rating = "needs_review";
  else rating = "bad";
  return {
    rating,
    score,
    reasons,
    metrics: {
      predictorScore: round(input.predictorScore),
      maskAreaRatio: round(metrics.maskAreaRatio),
      maskBoxFill: round(metrics.maskBoxFill),
      detectorCoverage: round(metrics.detectorCoverage),
      outsidePaddedBoxRatio: round(metrics.outsidePaddedBoxRatio),
      centerOccupancy: round(metrics.centerOccupancy),
      primaryComponentRatio: round(input.refinement.primaryComponentRatio),
      disconnectedComponentRatio: round(input.refinement.disconnectedComponentRatio),
      upperBodyHoleRatio: round(input.refinement.upperBodyHoleRatio),
    },
  };
}

function emptyQuality(reasons: string[]) {
  return {
    rating: "bad" as const,
    score: 0,
    reasons,
    metrics: {
      predictorScore: 0,
      maskAreaRatio: 0,
      maskBoxFill: 0,
      detectorCoverage: 0,
      outsidePaddedBoxRatio: 0,
      centerOccupancy: 0,
      primaryComponentRatio: 0,
      disconnectedComponentRatio: 0,
      upperBodyHoleRatio: 0,
    },
  };
}

export async function createVehicleSegmentationV3Cutout(
  original: Buffer,
  dependencies: {
    detector?: (source: Buffer) => Promise<VehicleDetection[]>;
    segmenter?: (source: Buffer, box: BoundingBox) => Promise<Segmentation>;
  } = {},
): Promise<VehicleSegmentationV3Result> {
  const metadata = await sharp(original, { failOn: "warning" }).rotate().metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("vehicle_segmentation_v3_source_invalid");
  const detections = await (dependencies.detector ?? detectVehicles)(original);
  const selection = selectPrimaryVehicle(detections, metadata.width, metadata.height);
  const eligibility = classifyFullVehicleGeometry({
    detection: selection.primary,
    width: metadata.width,
    height: metadata.height,
    ambiguous: selection.ambiguous,
  });
  const commonMetadata = {
    pipeline: VEHICLE_SEGMENTATION_V3_PIPELINE,
    detector: VEHICLE_SEGMENTATION_V3_MODELS.detector,
    segmenter: VEHICLE_SEGMENTATION_V3_MODELS.segmenter,
    method: "detector_box_prompted_segmentation" as const,
    maskResolution: 256 as const,
  };
  if (!selection.primary || eligibility.classification !== "FULL_VEHICLE") {
    return {
      bytes: null,
      rawBytes: null,
      refinedBytes: null,
      eligibility,
      selected: selection.primary,
      candidateCount: detections.length,
      ambiguous: selection.ambiguous,
      quality: emptyQuality(eligibility.reasons),
      metadata: { ...commonMetadata, refinementSelected: false, framing: null },
    };
  }
  const segmentation = await (dependencies.segmenter ?? segmentWithMobileSam)(
    original,
    selection.primary.box,
  );
  const refinement = refineAutomotiveMask(segmentation.mask, metadata.width, metadata.height);
  const rawQuality = scoreVehicleMask({
    mask: segmentation.mask,
    width: metadata.width,
    height: metadata.height,
    detection: selection.primary,
    eligibility,
    predictorScore: segmentation.predictorScore,
    refinement,
  });
  const refinedQuality = scoreVehicleMask({
    mask: refinement.mask,
    width: metadata.width,
    height: metadata.height,
    detection: selection.primary,
    eligibility,
    predictorScore: segmentation.predictorScore,
    refinement,
  });
  const useRefinement = refinedQuality.score > rawQuality.score + 0.025;
  const selectedMask = useRefinement ? refinement.mask : segmentation.mask;
  const quality = useRefinement ? refinedQuality : rawQuality;
  const [rawBytes, refinedBytes, bytes] = await Promise.all([
    renderVehicleMaskCutout(original, segmentation.mask, metadata.width, metadata.height),
    renderVehicleMaskCutout(original, refinement.mask, metadata.width, metadata.height),
    renderVehicleMaskCutout(original, selectedMask, metadata.width, metadata.height),
  ]);
  const aspectRatio = selection.primary.box.width / Math.max(1, selection.primary.box.height);
  return {
    bytes,
    rawBytes,
    refinedBytes,
    eligibility,
    selected: selection.primary,
    candidateCount: detections.length,
    ambiguous: selection.ambiguous,
    quality,
    metadata: {
      ...commonMetadata,
      refinementSelected: useRefinement,
      framing: { recommendedVehicleWidthRatio: aspectRatio >= 2.4 ? 0.77 : 0.82 },
    },
  };
}
