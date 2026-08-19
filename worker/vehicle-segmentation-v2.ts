import { access, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

export const VEHICLE_SEGMENTATION_V2_PIPELINE = "mask-rcnn-int8-full-vehicle-v2";
export const VEHICLE_SEGMENTATION_V2_MODEL = "mask-rcnn-r50-fpn-int8-opset12-coco";

const MODEL_FILENAME = "MaskRCNN-12-int8.onnx";
const VEHICLE_LABELS = new Map([
  [3, "car"],
  [6, "bus"],
  [8, "truck"],
]);
const SCORE_THRESHOLD = 0.18;
const MASK_THRESHOLD = 0.5;
const MAX_INSTANCES = 8;

export type VehicleEligibility = "FULL_VEHICLE" | "PARTIAL_VEHICLE" | "AMBIGUOUS" | "NON_VEHICLE";

export type VehicleSegmentationQuality = "good" | "needs_review" | "bad";

export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type VehicleInstance = {
  box: BoundingBox;
  confidence: number;
  classId: number;
  className: string;
  mask: Uint8Array;
  maskArea: number;
  rank?: number;
  completeness?: number;
};

export type EligibilityResult = {
  classification: VehicleEligibility;
  score: number;
  reasons: string[];
  metrics: {
    confidence: number;
    boxAreaRatio: number;
    maskAreaRatio: number;
    maskBoxFill: number;
    aspectRatio: number;
    centerProximity: number;
    edgeContacts: number;
    oppositeEdgeContact: boolean;
  };
};

export type VehicleSegmentationV2Result = {
  bytes: Buffer | null;
  eligibility: EligibilityResult;
  selected: Omit<VehicleInstance, "mask"> | null;
  candidateCount: number;
  ambiguous: boolean;
  quality: {
    rating: VehicleSegmentationQuality;
    score: number;
    reasons: string[];
    metrics: {
      primaryComponentRatio: number;
      disconnectedComponentRatio: number;
      holeRatio: number;
      upperBodyHoleRatio: number;
      maskBoxFill: number;
      edgeContactRatio: number;
      centerOccupancy: number;
    };
  };
  metadata: {
    pipeline: string;
    model: string;
    method: "vehicle_instance_segmentation";
    framing: { recommendedVehicleWidthRatio: number } | null;
  };
};

type Runtime = {
  ort: typeof import("onnxruntime-node");
  session: import("onnxruntime-node").InferenceSession;
};

type Component = {
  id: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

let runtimePromise: Promise<Runtime> | null = null;

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

function maskBounds(mask: Uint8Array, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    area += 1;
  }
  return {
    area,
    box: area > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}

function edgeRelationship(box: BoundingBox, imageWidth: number, imageHeight: number) {
  const horizontalTolerance = Math.max(3, imageWidth * 0.012);
  const verticalTolerance = Math.max(3, imageHeight * 0.012);
  const left = box.x <= horizontalTolerance;
  const top = box.y <= verticalTolerance;
  const right = box.x + box.width >= imageWidth - horizontalTolerance;
  const bottom = box.y + box.height >= imageHeight - verticalTolerance;
  return {
    left,
    top,
    right,
    bottom,
    count: [left, top, right, bottom].filter(Boolean).length,
    opposite: (left && right) || (top && bottom),
  };
}

function centerProximity(box: BoundingBox, width: number, height: number) {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const distance = Math.hypot(centerX - width / 2, centerY - height / 2);
  return 1 - clamp(distance / Math.hypot(width / 2, height / 2), 0, 1);
}

function connectedComponents(mask: Uint8Array, width: number, height: number) {
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: Component[] = [];
  let nextId = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    nextId += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = nextId;
    const component: Component = {
      id: nextId,
      area: 0,
      minX: width,
      minY: height,
      maxX: -1,
      maxY: -1,
    };
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      component.area += 1;
      component.minX = Math.min(component.minX, x);
      component.minY = Math.min(component.minY, y);
      component.maxX = Math.max(component.maxX, x);
      component.maxY = Math.max(component.maxY, y);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (mask[next] && !labels[next]) {
            labels[next] = nextId;
            queue[tail++] = next;
          }
        }
      }
    }
    components.push(component);
  }
  components.sort((left, right) => right.area - left.area);
  return { labels, components };
}

function componentGap(left: Component, right: Component) {
  const horizontal = Math.max(0, left.minX - right.maxX - 1, right.minX - left.maxX - 1);
  const vertical = Math.max(0, left.minY - right.maxY - 1, right.minY - left.maxY - 1);
  return Math.hypot(horizontal, vertical);
}

export function refineAutomotiveMask(mask: Uint8Array, width: number, height: number) {
  const { labels, components } = connectedComponents(mask, width, height);
  const primary = components[0];
  if (!primary) {
    return {
      mask: new Uint8Array(mask.length),
      primaryComponentRatio: 0,
      disconnectedComponentRatio: 0,
      holeRatio: 0,
      upperBodyHoleRatio: 0,
    };
  }
  const proximity = Math.max(width, height) * 0.035;
  const retained = new Set(
    components
      .filter(
        (component) =>
          component.id === primary.id ||
          (component.area >= primary.area * 0.0025 &&
            componentGap(component, primary) <= proximity),
      )
      .map((component) => component.id),
  );
  const cleaned = new Uint8Array(mask.length);
  let retainedArea = 0;
  let removedArea = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!labels[index]) continue;
    if (retained.has(labels[index])) {
      cleaned[index] = 1;
      retainedArea += 1;
    } else {
      removedArea += 1;
    }
  }

  const bounds = maskBounds(cleaned, width, height).box;
  if (!bounds || retainedArea === 0) {
    return {
      mask: cleaned,
      primaryComponentRatio: 0,
      disconnectedComponentRatio: 1,
      holeRatio: 0,
      upperBodyHoleRatio: 0,
    };
  }
  const background = new Uint8Array(cleaned.length);
  for (let index = 0; index < cleaned.length; index += 1)
    background[index] = cleaned[index] ? 0 : 1;
  const holes = connectedComponents(background, width, height);
  const border = new Set<number>();
  for (let x = 0; x < width; x += 1) {
    border.add(holes.labels[x]);
    border.add(holes.labels[(height - 1) * width + x]);
  }
  for (let y = 0; y < height; y += 1) {
    border.add(holes.labels[y * width]);
    border.add(holes.labels[y * width + width - 1]);
  }
  const boxPixels = Math.max(1, boxArea(bounds));
  let enclosedArea = 0;
  let upperBodyArea = 0;
  const fillable = new Set<number>();
  for (const component of holes.components) {
    if (border.has(component.id)) continue;
    enclosedArea += component.area;
    const centerY = (component.minY + component.maxY) / 2;
    const isUpperBody = centerY <= bounds.y + bounds.height * 0.66;
    if (isUpperBody) upperBodyArea += component.area;
    if (isUpperBody && component.area <= boxPixels * 0.018) fillable.add(component.id);
  }
  for (let index = 0; index < holes.labels.length; index += 1) {
    if (fillable.has(holes.labels[index])) cleaned[index] = 1;
  }
  return {
    mask: cleaned,
    primaryComponentRatio: primary.area / Math.max(1, retainedArea),
    disconnectedComponentRatio: removedArea / Math.max(1, retainedArea + removedArea),
    holeRatio: enclosedArea / boxPixels,
    upperBodyHoleRatio: upperBodyArea / boxPixels,
  };
}

export function classifyFullVehicle(input: {
  instance: VehicleInstance | null;
  imageWidth: number;
  imageHeight: number;
  ambiguous: boolean;
}): EligibilityResult {
  const { instance, imageWidth, imageHeight } = input;
  if (!instance) {
    return {
      classification: "NON_VEHICLE",
      score: 0,
      reasons: ["no_vehicle_instance"],
      metrics: {
        confidence: 0,
        boxAreaRatio: 0,
        maskAreaRatio: 0,
        maskBoxFill: 0,
        aspectRatio: 0,
        centerProximity: 0,
        edgeContacts: 0,
        oppositeEdgeContact: false,
      },
    };
  }
  const imageArea = imageWidth * imageHeight;
  const areaRatio = boxArea(instance.box) / imageArea;
  const maskAreaRatio = instance.maskArea / imageArea;
  const maskBoxFill = instance.maskArea / Math.max(1, boxArea(instance.box));
  const aspectRatio = instance.box.width / Math.max(1, instance.box.height);
  const proximity = centerProximity(instance.box, imageWidth, imageHeight);
  const edges = edgeRelationship(instance.box, imageWidth, imageHeight);
  const areaScore = clamp((areaRatio - 0.045) / 0.24, 0, 1) * (areaRatio > 0.9 ? 0.3 : 1);
  const fillScore = clamp(1 - Math.abs(maskBoxFill - 0.58) / 0.5, 0, 1);
  const aspectScore = aspectRatio >= 1 && aspectRatio <= 4.8 ? 1 : 0.25;
  const edgeScore = clamp(1 - edges.count * 0.16 - (edges.opposite ? 0.32 : 0), 0, 1);
  const score = round(
    instance.confidence * 0.3 +
      areaScore * 0.23 +
      fillScore * 0.17 +
      aspectScore * 0.1 +
      edgeScore * 0.12 +
      proximity * 0.08,
  );
  const reasons: string[] = [];
  if (input.ambiguous) reasons.push("multiple_plausible_complete_vehicles");
  if (areaRatio < 0.055) reasons.push("vehicle_too_small_for_full_exterior");
  if (maskAreaRatio < 0.035) reasons.push("insufficient_visible_vehicle_area");
  if (edges.count >= 3 || (edges.opposite && areaRatio >= 0.62))
    reasons.push("vehicle_geometry_clipped_by_frame");
  if (areaRatio > 0.94) reasons.push("instance_fills_frame_like_partial_or_interior");
  if (aspectRatio < 0.82 || aspectRatio > 5.2) reasons.push("implausible_full_vehicle_aspect");
  if (maskBoxFill < 0.16) reasons.push("fragmentary_vehicle_mask");
  if (instance.confidence < 0.34) reasons.push("low_instance_confidence");

  let classification: VehicleEligibility;
  if (input.ambiguous) classification = "AMBIGUOUS";
  else if (
    reasons.includes("vehicle_geometry_clipped_by_frame") ||
    reasons.includes("instance_fills_frame_like_partial_or_interior") ||
    reasons.includes("implausible_full_vehicle_aspect")
  ) {
    classification = "PARTIAL_VEHICLE";
  } else if (score >= 0.67 && reasons.length === 0) classification = "FULL_VEHICLE";
  else if (score >= 0.52) classification = "AMBIGUOUS";
  else classification = "PARTIAL_VEHICLE";

  return {
    classification,
    score,
    reasons,
    metrics: {
      confidence: round(instance.confidence),
      boxAreaRatio: round(areaRatio),
      maskAreaRatio: round(maskAreaRatio),
      maskBoxFill: round(maskBoxFill),
      aspectRatio: round(aspectRatio),
      centerProximity: round(proximity),
      edgeContacts: edges.count,
      oppositeEdgeContact: edges.opposite,
    },
  };
}

export function selectPrimaryVehicleInstance(
  instances: VehicleInstance[],
  imageWidth: number,
  imageHeight: number,
) {
  const imageArea = imageWidth * imageHeight;
  const ranked = instances
    .map((instance) => {
      const areaRatio = boxArea(instance.box) / imageArea;
      const proximity = centerProximity(instance.box, imageWidth, imageHeight);
      const edges = edgeRelationship(instance.box, imageWidth, imageHeight);
      const completeness = clamp(1 - edges.count * 0.14 - (edges.opposite ? 0.25 : 0), 0, 1);
      const rank =
        instance.confidence *
        Math.sqrt(Math.max(areaRatio, 0.0001)) *
        (0.45 + proximity * 0.35 + completeness * 0.2);
      return { ...instance, rank, completeness };
    })
    .sort((left, right) => (right.rank ?? 0) - (left.rank ?? 0));
  const primary = ranked[0] ?? null;
  const secondary = ranked[1] ?? null;
  const ambiguous = Boolean(
    primary &&
    secondary &&
    (secondary.rank ?? 0) >= (primary.rank ?? 0) * 0.8 &&
    boxArea(secondary.box) >= boxArea(primary.box) * 0.58,
  );
  return { primary, ranked, ambiguous };
}

function scoreMask(input: {
  mask: Uint8Array;
  width: number;
  height: number;
  instance: VehicleInstance;
  eligibility: EligibilityResult;
  refinement: ReturnType<typeof refineAutomotiveMask>;
}) {
  const bounds = maskBounds(input.mask, input.width, input.height);
  const fill = bounds.box ? bounds.area / Math.max(1, boxArea(bounds.box)) : 0;
  const edges = bounds.box ? edgeRelationship(bounds.box, input.width, input.height) : { count: 4 };
  const centerLeft = Math.floor(input.instance.box.x + input.instance.box.width * 0.3);
  const centerRight = Math.ceil(input.instance.box.x + input.instance.box.width * 0.7);
  const centerTop = Math.floor(input.instance.box.y + input.instance.box.height * 0.3);
  const centerBottom = Math.ceil(input.instance.box.y + input.instance.box.height * 0.7);
  let centerPixels = 0;
  let centerForeground = 0;
  for (let y = centerTop; y < centerBottom; y += 1) {
    for (let x = centerLeft; x < centerRight; x += 1) {
      if (x < 0 || x >= input.width || y < 0 || y >= input.height) continue;
      centerPixels += 1;
      if (input.mask[y * input.width + x]) centerForeground += 1;
    }
  }
  const centerOccupancy = centerForeground / Math.max(1, centerPixels);
  const edgeContactRatio = edges.count / 4;
  const score = round(
    input.eligibility.score * 0.28 +
      input.refinement.primaryComponentRatio * 0.2 +
      clamp(1 - input.refinement.disconnectedComponentRatio * 5, 0, 1) * 0.12 +
      clamp(1 - input.refinement.upperBodyHoleRatio * 10, 0, 1) * 0.13 +
      clamp(fill / 0.55, 0, 1) * 0.12 +
      centerOccupancy * 0.1 +
      clamp(1 - edgeContactRatio * 0.5, 0, 1) * 0.05,
  );
  const reasons = [...input.eligibility.reasons];
  if (input.refinement.primaryComponentRatio < 0.94) reasons.push("fragmented_vehicle_geometry");
  if (input.refinement.disconnectedComponentRatio > 0.04)
    reasons.push("unrelated_disconnected_components");
  if (input.refinement.upperBodyHoleRatio > 0.045) reasons.push("glass_or_body_holes_excessive");
  if (fill < 0.28) reasons.push("vehicle_silhouette_too_sparse");
  if (centerOccupancy < 0.55) reasons.push("missing_vehicle_center_mass");
  let rating: VehicleSegmentationQuality;
  if (input.eligibility.classification !== "FULL_VEHICLE") rating = "bad";
  else if (score >= 0.78 && reasons.length === 0) rating = "good";
  else if (score >= 0.55) rating = "needs_review";
  else rating = "bad";
  return {
    rating,
    score,
    reasons,
    metrics: {
      primaryComponentRatio: round(input.refinement.primaryComponentRatio),
      disconnectedComponentRatio: round(input.refinement.disconnectedComponentRatio),
      holeRatio: round(input.refinement.holeRatio),
      upperBodyHoleRatio: round(input.refinement.upperBodyHoleRatio),
      maskBoxFill: round(fill),
      edgeContactRatio: round(edgeContactRatio),
      centerOccupancy: round(centerOccupancy),
    },
  };
}

async function modelPath() {
  const candidates = [
    path.resolve(process.cwd(), ".output/public/vehicle-segmentation-v2", MODEL_FILENAME),
    path.resolve(process.cwd(), "public/vehicle-segmentation-v2", MODEL_FILENAME),
    path.resolve(process.env.TEMP ?? process.cwd(), "dealershot-v2-models", MODEL_FILENAME),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // V2 is prepared only by the explicit experiment command.
    }
  }
  throw new Error("vehicle_segmentation_v2_model_unavailable");
}

async function runtime() {
  runtimePromise ??= (async () => {
    const [ort, model] = await Promise.all([
      import("onnxruntime-node"),
      readFile(await modelPath()),
    ]);
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      executionMode: "sequential",
      enableCpuMemArena: false,
    });
    return { ort, session };
  })();
  return runtimePromise;
}

export async function releaseVehicleSegmentationV2Runtime() {
  const pending = runtimePromise;
  runtimePromise = null;
  if (pending) {
    const loaded = await pending;
    await loaded.session.release();
  }
}

function identifyOutputs(outputs: Record<string, import("onnxruntime-node").Tensor>) {
  const values = Object.values(outputs);
  const boxes = values.find(
    (value) => value.type === "float32" && value.dims.length === 2 && value.dims[1] === 4,
  );
  const labels = values.find((value) => value.type === "int64" && value.dims.length === 1);
  const scores = values.find(
    (value) =>
      value.type === "float32" &&
      value.dims.length === 1 &&
      value.data.length === labels?.data.length,
  );
  const masks = values.find(
    (value) =>
      value.type === "float32" &&
      value.dims.length === 4 &&
      value.dims[2] === 28 &&
      value.dims[3] === 28,
  );
  if (!boxes || !labels || !scores || !masks)
    throw new Error("vehicle_segmentation_v2_output_invalid");
  return { boxes, labels, scores, masks };
}

async function pasteInstanceMask(
  values: Float32Array,
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number,
) {
  const left = Math.floor(clamp(box.x, 0, imageWidth - 1));
  const top = Math.floor(clamp(box.y, 0, imageHeight - 1));
  const right = Math.ceil(clamp(box.x + box.width, left + 1, imageWidth));
  const bottom = Math.ceil(clamp(box.y + box.height, top + 1, imageHeight));
  const targetWidth = right - left;
  const targetHeight = bottom - top;
  const probabilities = Buffer.allocUnsafe(28 * 28);
  for (let index = 0; index < probabilities.length; index += 1) {
    probabilities[index] = Math.round(clamp(values[index], 0, 1) * 255);
  }
  const resized = await sharp(probabilities, { raw: { width: 28, height: 28, channels: 1 } })
    .resize(targetWidth, targetHeight, { fit: "fill", kernel: "linear" })
    .raw()
    .toBuffer();
  const mask = new Uint8Array(imageWidth * imageHeight);
  let area = 0;
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      if (resized[y * targetWidth + x] / 255 < MASK_THRESHOLD) continue;
      mask[(top + y) * imageWidth + left + x] = 1;
      area += 1;
    }
  }
  return { mask, area };
}

export async function detectVehicleInstances(original: Buffer): Promise<VehicleInstance[]> {
  const metadata = await sharp(original, { failOn: "warning" }).rotate().metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("vehicle_segmentation_v2_source_invalid");
  const scale = Math.min(
    800 / Math.min(metadata.width, metadata.height),
    1_333 / Math.max(metadata.width, metadata.height),
  );
  const resizedWidth = Math.max(1, Math.round(metadata.width * scale));
  const resizedHeight = Math.max(1, Math.round(metadata.height * scale));
  const paddedWidth = Math.ceil(resizedWidth / 32) * 32;
  const paddedHeight = Math.ceil(resizedHeight / 32) * 32;
  const { data } = await sharp(original, { failOn: "warning" })
    .rotate()
    .resize(resizedWidth, resizedHeight, { fit: "fill" })
    .removeAlpha()
    .extend({
      right: paddedWidth - resizedWidth,
      bottom: paddedHeight - resizedHeight,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = paddedWidth * paddedHeight;
  const input = new Float32Array(plane * 3);
  const means = [102.9801, 115.9465, 122.7717];
  for (let pixel = 0; pixel < plane; pixel += 1) {
    const source = pixel * 3;
    input[pixel] = data[source + 2] - means[0];
    input[pixel + plane] = data[source + 1] - means[1];
    input[pixel + plane * 2] = data[source] - means[2];
  }
  const loaded = await runtime();
  const outputs = identifyOutputs(
    await loaded.session.run({
      image: new loaded.ort.Tensor("float32", input, [3, paddedHeight, paddedWidth]),
    }),
  );
  const candidates: Array<{
    index: number;
    confidence: number;
    classId: number;
    box: BoundingBox;
  }> = [];
  for (let index = 0; index < outputs.labels.data.length; index += 1) {
    const classId = Number(outputs.labels.data[index]);
    const confidence = Number(outputs.scores.data[index]);
    if (!VEHICLE_LABELS.has(classId) || confidence < SCORE_THRESHOLD) continue;
    const offset = index * 4;
    const left = clamp(Number(outputs.boxes.data[offset]) / scale, 0, metadata.width - 1);
    const top = clamp(Number(outputs.boxes.data[offset + 1]) / scale, 0, metadata.height - 1);
    const right = clamp(Number(outputs.boxes.data[offset + 2]) / scale, left + 1, metadata.width);
    const bottom = clamp(Number(outputs.boxes.data[offset + 3]) / scale, top + 1, metadata.height);
    candidates.push({
      index,
      confidence,
      classId,
      box: { x: left, y: top, width: right - left, height: bottom - top },
    });
  }
  candidates.sort((left, right) => right.confidence - left.confidence);
  const instances: VehicleInstance[] = [];
  for (const candidate of candidates.slice(0, MAX_INSTANCES)) {
    const start = candidate.index * 28 * 28;
    const probabilities = (outputs.masks.data as Float32Array).subarray(start, start + 28 * 28);
    const { mask, area } = await pasteInstanceMask(
      probabilities,
      candidate.box,
      metadata.width,
      metadata.height,
    );
    if (area === 0) continue;
    instances.push({
      box: candidate.box,
      confidence: candidate.confidence,
      classId: candidate.classId,
      className: VEHICLE_LABELS.get(candidate.classId) ?? "vehicle",
      mask,
      maskArea: area,
    });
  }
  return instances;
}

async function composeTransparentCutout(
  original: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const { data, info } = await sharp(original, { failOn: "warning" })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height)
    throw new Error("vehicle_segmentation_v2_size_mismatch");
  const alpha = await sharp(Buffer.from(mask.map((value) => (value ? 255 : 0))), {
    raw: { width, height, channels: 1 },
  })
    .blur(0.55)
    .extractChannel(0)
    .raw()
    .toBuffer();
  if (alpha.length !== width * height) throw new Error("vehicle_segmentation_v2_alpha_invalid");
  for (let pixel = 0; pixel < width * height; pixel += 1) data[pixel * 4 + 3] = alpha[pixel];
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function renderVehicleMaskCutout(
  original: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  return composeTransparentCutout(original, mask, width, height);
}

function withoutMask(instance: VehicleInstance | null) {
  if (!instance) return null;
  const { mask: _mask, ...safe } = instance;
  return safe;
}

export async function createVehicleSegmentationV2Cutout(
  original: Buffer,
  detector: (source: Buffer) => Promise<VehicleInstance[]> = detectVehicleInstances,
): Promise<VehicleSegmentationV2Result> {
  const metadata = await sharp(original, { failOn: "warning" }).rotate().metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("vehicle_segmentation_v2_source_invalid");
  const instances = await detector(original);
  const selection = selectPrimaryVehicleInstance(instances, metadata.width, metadata.height);
  const eligibility = classifyFullVehicle({
    instance: selection.primary,
    imageWidth: metadata.width,
    imageHeight: metadata.height,
    ambiguous: selection.ambiguous,
  });
  const emptyQuality = {
    rating: "bad" as const,
    score: 0,
    reasons: [...eligibility.reasons],
    metrics: {
      primaryComponentRatio: 0,
      disconnectedComponentRatio: 0,
      holeRatio: 0,
      upperBodyHoleRatio: 0,
      maskBoxFill: 0,
      edgeContactRatio: 0,
      centerOccupancy: 0,
    },
  };
  if (!selection.primary || eligibility.classification !== "FULL_VEHICLE") {
    return {
      bytes: null,
      eligibility,
      selected: withoutMask(selection.primary),
      candidateCount: instances.length,
      ambiguous: selection.ambiguous,
      quality: emptyQuality,
      metadata: {
        pipeline: VEHICLE_SEGMENTATION_V2_PIPELINE,
        model: VEHICLE_SEGMENTATION_V2_MODEL,
        method: "vehicle_instance_segmentation",
        framing: null,
      },
    };
  }
  const refinement = refineAutomotiveMask(selection.primary.mask, metadata.width, metadata.height);
  const quality = scoreMask({
    mask: refinement.mask,
    width: metadata.width,
    height: metadata.height,
    instance: selection.primary,
    eligibility,
    refinement,
  });
  const bytes = await composeTransparentCutout(
    original,
    refinement.mask,
    metadata.width,
    metadata.height,
  );
  const aspect = selection.primary.box.width / Math.max(1, selection.primary.box.height);
  return {
    bytes,
    eligibility,
    selected: withoutMask(selection.primary),
    candidateCount: instances.length,
    ambiguous: selection.ambiguous,
    quality,
    metadata: {
      pipeline: VEHICLE_SEGMENTATION_V2_PIPELINE,
      model: VEHICLE_SEGMENTATION_V2_MODEL,
      method: "vehicle_instance_segmentation",
      framing: { recommendedVehicleWidthRatio: aspect >= 2.4 ? 0.77 : 0.82 },
    },
  };
}
