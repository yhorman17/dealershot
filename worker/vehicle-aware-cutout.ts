import { access, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

export const VEHICLE_DETECTOR_VERSION = "yolox-nano-0.1.1rc0-coco";
export const VEHICLE_AWARE_PIPELINE_VERSION = "detector-roi-isnet-v1";

const DETECTOR_SIZE = 416;
const VEHICLE_CLASS_INDEXES = new Map([
  [2, "car"],
  [3, "motorcycle"],
  [5, "bus"],
  [7, "truck"],
]);
const DETECTION_CONFIDENCE = 0.2;
const NMS_THRESHOLD = 0.45;
const ROI_PADDING_RATIO = 0.08;
const MASK_ANALYSIS_LIMIT = 512;

export type VehicleDetection = {
  box: BoundingBox;
  confidence: number;
  classId: number;
  className: string;
  rank?: number;
};

export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type VehicleMaskQuality = {
  rating: "good" | "questionable" | "bad";
  score: number;
  reasons: string[];
  metrics: {
    detectorConfidence: number;
    detectorMaskCoverage: number;
    maskBoxCoverage: number;
    primaryComponentRatio: number;
    centerOccupancy: number;
    edgeContactRatio: number;
    enclosedHoleRatio: number;
    ambiguous: boolean;
  };
};

export type VehicleAwareCutoutResult = {
  bytes: Buffer;
  method: "vehicle_aware" | "standard_fallback";
  detector: {
    model: string;
    selected: VehicleDetection | null;
    candidateCount: number;
    ambiguous: boolean;
  };
  roi: BoundingBox | null;
  quality: VehicleMaskQuality;
  framing: { recommendedVehicleWidthRatio: number } | null;
};

type DetectorRuntime = {
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

let detectorRuntime: Promise<DetectorRuntime> | null = null;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function rounded(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function intersectionOverUnion(a: BoundingBox, b: BoundingBox) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

export function expandVehicleRegion(
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  paddingRatio = ROI_PADDING_RATIO,
): BoundingBox {
  const horizontalPadding = box.width * paddingRatio;
  const verticalPadding = box.height * paddingRatio;
  const left = Math.floor(clamp(box.x - horizontalPadding, 0, imageWidth - 1));
  const top = Math.floor(clamp(box.y - verticalPadding, 0, imageHeight - 1));
  const right = Math.ceil(clamp(box.x + box.width + horizontalPadding, left + 1, imageWidth));
  const bottom = Math.ceil(clamp(box.y + box.height + verticalPadding, top + 1, imageHeight));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function selectPrimaryVehicle(
  detections: VehicleDetection[],
  imageWidth: number,
  imageHeight: number,
) {
  const imageArea = imageWidth * imageHeight;
  const diagonal = Math.hypot(imageWidth / 2, imageHeight / 2);
  const ranked = detections
    .map((detection) => {
      const centerX = detection.box.x + detection.box.width / 2;
      const centerY = detection.box.y + detection.box.height / 2;
      const centerDistance = Math.hypot(centerX - imageWidth / 2, centerY - imageHeight / 2);
      const centerProximity = 1 - clamp(centerDistance / diagonal, 0, 1);
      const areaRatio = (detection.box.width * detection.box.height) / imageArea;
      const rank =
        detection.confidence *
        Math.sqrt(Math.max(areaRatio, 0.0001)) *
        (0.5 + centerProximity * 0.5);
      return { ...detection, rank };
    })
    .sort((left, right) => (right.rank ?? 0) - (left.rank ?? 0));
  const primary = ranked[0] ?? null;
  const secondary = ranked[1] ?? null;
  const ambiguous = Boolean(
    primary &&
    secondary &&
    (secondary.rank ?? 0) >= (primary.rank ?? 0) * 0.78 &&
    secondary.box.width * secondary.box.height >= primary.box.width * primary.box.height * 0.5 &&
    intersectionOverUnion(primary.box, secondary.box) < 0.25,
  );
  return { primary, ranked, ambiguous };
}

function nonMaximumSuppression(detections: VehicleDetection[]) {
  const pending = [...detections].sort((left, right) => right.confidence - left.confidence);
  const kept: VehicleDetection[] = [];
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (!candidate) break;
    kept.push(candidate);
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (intersectionOverUnion(candidate.box, pending[index].box) > NMS_THRESHOLD) {
        pending.splice(index, 1);
      }
    }
  }
  return kept;
}

async function detectorAssetPath() {
  const candidates = [
    path.resolve(process.cwd(), ".output/public/vehicle-detection/yolox_nano.onnx"),
    path.resolve(process.cwd(), "public/vehicle-detection/yolox_nano.onnx"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Production output is preferred; source is a focused local fallback.
    }
  }
  throw new Error("vehicle_detector_unavailable");
}

async function getDetectorRuntime() {
  detectorRuntime ??= (async () => {
    const [ort, model] = await Promise.all([
      import("onnxruntime-node"),
      readFile(await detectorAssetPath()),
    ]);
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      executionMode: "sequential",
      enableCpuMemArena: true,
    });
    return { ort, session };
  })();
  return detectorRuntime;
}

export async function detectVehicleCandidates(original: Buffer) {
  const metadata = await sharp(original, { failOn: "warning" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("vehicle_detector_source_invalid");
  const scale = Math.min(DETECTOR_SIZE / metadata.width, DETECTOR_SIZE / metadata.height);
  const { data, info } = await sharp(original, { failOn: "warning" })
    .removeAlpha()
    .resize(DETECTOR_SIZE, DETECTOR_SIZE, {
      fit: "contain",
      position: "left top",
      background: { r: 114, g: 114, b: 114 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error("vehicle_detector_source_invalid");

  const plane = DETECTOR_SIZE * DETECTOR_SIZE;
  const input = new Float32Array(plane * 3);
  for (let pixel = 0; pixel < plane; pixel += 1) {
    const source = pixel * 3;
    input[pixel] = data[source + 2];
    input[pixel + plane] = data[source + 1];
    input[pixel + plane * 2] = data[source];
  }

  const { ort, session } = await getDetectorRuntime();
  const outputs = await session.run({
    images: new ort.Tensor("float32", input, [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]),
  });
  const prediction = outputs.output ?? Object.values(outputs)[0];
  if (!prediction || prediction.data.length !== 3_549 * 85) {
    throw new Error("vehicle_detector_output_invalid");
  }

  const values = prediction.data as Float32Array;
  const detections: VehicleDetection[] = [];
  const strides = [8, 16, 32];
  let row = 0;
  for (const stride of strides) {
    const gridSize = DETECTOR_SIZE / stride;
    for (let gridY = 0; gridY < gridSize; gridY += 1) {
      for (let gridX = 0; gridX < gridSize; gridX += 1) {
        const offset = row * 85;
        const objectConfidence = Number(values[offset + 4]);
        let bestClassId = -1;
        let bestClassConfidence = 0;
        for (const classId of VEHICLE_CLASS_INDEXES.keys()) {
          const confidence = Number(values[offset + 5 + classId]);
          if (confidence > bestClassConfidence) {
            bestClassConfidence = confidence;
            bestClassId = classId;
          }
        }
        const confidence = objectConfidence * bestClassConfidence;
        if (confidence >= DETECTION_CONFIDENCE && VEHICLE_CLASS_INDEXES.has(bestClassId)) {
          const centerX = (Number(values[offset]) + gridX) * stride;
          const centerY = (Number(values[offset + 1]) + gridY) * stride;
          const width = Math.exp(Number(values[offset + 2])) * stride;
          const height = Math.exp(Number(values[offset + 3])) * stride;
          const left = clamp((centerX - width / 2) / scale, 0, metadata.width - 1);
          const top = clamp((centerY - height / 2) / scale, 0, metadata.height - 1);
          const right = clamp((centerX + width / 2) / scale, left + 1, metadata.width);
          const bottom = clamp((centerY + height / 2) / scale, top + 1, metadata.height);
          detections.push({
            box: { x: left, y: top, width: right - left, height: bottom - top },
            confidence,
            classId: bestClassId,
            className: VEHICLE_CLASS_INDEXES.get(bestClassId) ?? "vehicle",
          });
        }
        row += 1;
      }
    }
  }
  return nonMaximumSuppression(detections);
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
      maxX: 0,
      maxY: 0,
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
  return { labels, components: components.sort((left, right) => right.area - left.area) };
}

function componentGap(left: Component, right: Component) {
  const horizontal = Math.max(0, left.minX - right.maxX - 1, right.minX - left.maxX - 1);
  const vertical = Math.max(0, left.minY - right.maxY - 1, right.minY - left.maxY - 1);
  return Math.hypot(horizontal, vertical);
}

function keepPrimaryComponents(mask: Uint8Array, width: number, height: number) {
  const { labels, components } = connectedComponents(mask, width, height);
  const primary = components[0];
  if (!primary) return { mask: new Uint8Array(mask.length), components, primaryAreaRatio: 0 };
  const proximityLimit = Math.max(width, height) * 0.03;
  const retained = new Set(
    components
      .filter(
        (component) =>
          component.id === primary.id ||
          (component.area >= primary.area * 0.012 &&
            componentGap(component, primary) <= proximityLimit),
      )
      .map((component) => component.id),
  );
  const cleaned = new Uint8Array(mask.length);
  let retainedArea = 0;
  for (let index = 0; index < labels.length; index += 1) {
    if (retained.has(labels[index])) {
      cleaned[index] = 1;
      retainedArea += 1;
    }
  }
  return {
    mask: cleaned,
    components,
    primaryAreaRatio: retainedArea > 0 ? primary.area / retainedArea : 0,
  };
}

function fillSmallEnclosedHoles(mask: Uint8Array, width: number, height: number, limit: number) {
  const background = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) background[index] = mask[index] ? 0 : 1;
  const { labels, components } = connectedComponents(background, width, height);
  const border = new Set<number>();
  for (let x = 0; x < width; x += 1) {
    border.add(labels[x]);
    border.add(labels[(height - 1) * width + x]);
  }
  for (let y = 0; y < height; y += 1) {
    border.add(labels[y * width]);
    border.add(labels[y * width + width - 1]);
  }
  const fillable = new Set(
    components
      .filter((component) => !border.has(component.id) && component.area <= limit)
      .map((component) => component.id),
  );
  const filled = new Uint8Array(mask);
  let holeArea = 0;
  for (let index = 0; index < labels.length; index += 1) {
    if (fillable.has(labels[index])) {
      filled[index] = 1;
      holeArea += 1;
    }
  }
  const enclosedArea = components
    .filter((component) => !border.has(component.id))
    .reduce((total, component) => total + component.area, 0);
  return { mask: filled, filledHoleArea: holeArea, enclosedArea };
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

export function scoreVehicleMask(input: {
  mask: Uint8Array;
  width: number;
  height: number;
  detectorBox: BoundingBox;
  detectorConfidence: number;
  primaryComponentRatio: number;
  enclosedHoleArea: number;
  ambiguous: boolean;
}): VehicleMaskQuality {
  const { area, box } = maskBounds(input.mask, input.width, input.height);
  const detectorArea = Math.max(1, input.detectorBox.width * input.detectorBox.height);
  const detectorMaskCoverage = area / detectorArea;
  const maskBoxCoverage = box
    ? Math.min(1, box.width / input.detectorBox.width) *
      Math.min(1, box.height / input.detectorBox.height)
    : 0;
  const centerLeft = Math.floor(input.detectorBox.x + input.detectorBox.width * 0.35);
  const centerRight = Math.ceil(input.detectorBox.x + input.detectorBox.width * 0.65);
  const centerTop = Math.floor(input.detectorBox.y + input.detectorBox.height * 0.35);
  const centerBottom = Math.ceil(input.detectorBox.y + input.detectorBox.height * 0.65);
  let centerPixels = 0;
  let centerForeground = 0;
  for (let y = centerTop; y < centerBottom; y += 1) {
    for (let x = centerLeft; x < centerRight; x += 1) {
      if (x < 0 || x >= input.width || y < 0 || y >= input.height) continue;
      centerPixels += 1;
      centerForeground += input.mask[y * input.width + x] ? 1 : 0;
    }
  }
  const centerOccupancy = centerPixels > 0 ? centerForeground / centerPixels : 0;
  let edgeForeground = 0;
  const perimeter = input.width * 2 + Math.max(0, input.height - 2) * 2;
  for (let x = 0; x < input.width; x += 1) {
    edgeForeground += input.mask[x] ? 1 : 0;
    edgeForeground += input.mask[(input.height - 1) * input.width + x] ? 1 : 0;
  }
  for (let y = 1; y < input.height - 1; y += 1) {
    edgeForeground += input.mask[y * input.width] ? 1 : 0;
    edgeForeground += input.mask[y * input.width + input.width - 1] ? 1 : 0;
  }
  const edgeContactRatio = perimeter > 0 ? edgeForeground / perimeter : 1;
  const enclosedHoleRatio = area > 0 ? input.enclosedHoleArea / area : 1;
  const coverageScore =
    detectorMaskCoverage >= 0.22 && detectorMaskCoverage <= 1.25
      ? 1
      : detectorMaskCoverage < 0.22
        ? detectorMaskCoverage / 0.22
        : Math.max(0, 1 - (detectorMaskCoverage - 1.25) / 0.75);
  let score =
    clamp(input.detectorConfidence, 0, 1) * 0.18 +
    clamp(coverageScore, 0, 1) * 0.2 +
    clamp(maskBoxCoverage, 0, 1) * 0.2 +
    clamp(input.primaryComponentRatio, 0, 1) * 0.18 +
    clamp(centerOccupancy, 0, 1) * 0.14 +
    (1 - clamp(edgeContactRatio / 0.25, 0, 1)) * 0.06 +
    (1 - clamp(enclosedHoleRatio / 0.18, 0, 1)) * 0.04;
  if (input.ambiguous) score -= 0.2;
  score = clamp(score, 0, 1);

  const reasons: string[] = [];
  if (input.ambiguous) reasons.push("ambiguous_primary_vehicle");
  if (detectorMaskCoverage < 0.22) reasons.push("insufficient_vehicle_coverage");
  if (detectorMaskCoverage > 1.25) reasons.push("mask_exceeds_vehicle_region");
  if (maskBoxCoverage < 0.65) reasons.push("missing_vehicle_geometry");
  if (input.primaryComponentRatio < 0.88) reasons.push("fragmented_mask");
  if (centerOccupancy < 0.35) reasons.push("missing_vehicle_center");
  if (edgeContactRatio > 0.2) reasons.push("unexpected_roi_edge_contact");
  if (enclosedHoleRatio > 0.12) reasons.push("excessive_mask_holes");

  const rating =
    score < 0.42 || detectorMaskCoverage < 0.1 || centerOccupancy < 0.08
      ? "bad"
      : score < 0.72 || input.ambiguous || reasons.length > 0
        ? "questionable"
        : "good";
  return {
    rating,
    score: rounded(score),
    reasons,
    metrics: {
      detectorConfidence: rounded(input.detectorConfidence),
      detectorMaskCoverage: rounded(detectorMaskCoverage),
      maskBoxCoverage: rounded(maskBoxCoverage),
      primaryComponentRatio: rounded(input.primaryComponentRatio),
      centerOccupancy: rounded(centerOccupancy),
      edgeContactRatio: rounded(edgeContactRatio),
      enclosedHoleRatio: rounded(enclosedHoleRatio),
      ambiguous: input.ambiguous,
    },
  };
}

function fallbackQuality(reason: string): VehicleMaskQuality {
  return {
    rating: "bad",
    score: 0,
    reasons: [reason],
    metrics: {
      detectorConfidence: 0,
      detectorMaskCoverage: 0,
      maskBoxCoverage: 0,
      primaryComponentRatio: 0,
      centerOccupancy: 0,
      edgeContactRatio: 0,
      enclosedHoleRatio: 0,
      ambiguous: false,
    },
  };
}

async function refineCutoutMask(
  cutout: Buffer,
  detectorBox: BoundingBox,
  detectorConfidence: number,
  ambiguous: boolean,
) {
  const metadata = await sharp(cutout, { failOn: "warning" }).metadata();
  if (!metadata.width || !metadata.height || !metadata.hasAlpha) {
    throw new Error("vehicle_mask_invalid");
  }
  const scale = Math.min(1, MASK_ANALYSIS_LIMIT / Math.max(metadata.width, metadata.height));
  const width = Math.max(1, Math.round(metadata.width * scale));
  const height = Math.max(1, Math.round(metadata.height * scale));
  const alpha = await sharp(cutout)
    .extractChannel(3)
    .resize(width, height, { fit: "fill", kernel: "linear" })
    .raw()
    .toBuffer();
  const binary = new Uint8Array(alpha.length);
  for (let index = 0; index < alpha.length; index += 1) binary[index] = alpha[index] >= 32 ? 1 : 0;
  const primary = keepPrimaryComponents(binary, width, height);
  const primaryArea = primary.components[0]?.area ?? 0;
  const holes = fillSmallEnclosedHoles(
    primary.mask,
    width,
    height,
    Math.max(4, Math.round(primaryArea * 0.02)),
  );
  const cleanAlpha = Buffer.allocUnsafe(alpha.length);
  for (let index = 0; index < alpha.length; index += 1) {
    if (!holes.mask[index]) cleanAlpha[index] = 0;
    else if (!primary.mask[index]) cleanAlpha[index] = Math.max(alpha[index], 230);
    else cleanAlpha[index] = alpha[index];
  }
  const fullAlpha = await sharp(cleanAlpha, { raw: { width, height, channels: 1 } })
    .resize(metadata.width, metadata.height, { fit: "fill", kernel: "cubic" })
    .blur(0.4)
    .greyscale()
    .raw()
    .toBuffer();
  const { data: pixels, info } = await sharp(cutout)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let index = 0; index < info.width * info.height; index += 1) {
    pixels[index * 4 + 3] = fullAlpha[index];
  }
  const refined = await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const quality = scoreVehicleMask({
    mask: holes.mask,
    width,
    height,
    detectorBox: {
      x: detectorBox.x * scale,
      y: detectorBox.y * scale,
      width: detectorBox.width * scale,
      height: detectorBox.height * scale,
    },
    detectorConfidence,
    primaryComponentRatio: primary.primaryAreaRatio,
    enclosedHoleArea: holes.enclosedArea,
    ambiguous,
  });
  return { bytes: refined, quality };
}

export async function createVehicleAwareCutout(
  original: Buffer,
  removeBackground: (source: Buffer) => Promise<Buffer>,
  detect: (source: Buffer) => Promise<VehicleDetection[]> = detectVehicleCandidates,
): Promise<VehicleAwareCutoutResult> {
  const normalized = await sharp(original, { failOn: "warning" }).rotate().toBuffer();
  const metadata = await sharp(normalized).metadata();
  if (!metadata.width || !metadata.height) throw new Error("vehicle_detector_source_invalid");
  const detections = await detect(normalized);
  const selection = selectPrimaryVehicle(detections, metadata.width, metadata.height);
  if (!selection.primary) {
    return {
      bytes: await removeBackground(normalized),
      method: "standard_fallback",
      detector: {
        model: VEHICLE_DETECTOR_VERSION,
        selected: null,
        candidateCount: 0,
        ambiguous: false,
      },
      roi: null,
      quality: fallbackQuality("no_vehicle_detected"),
      framing: null,
    };
  }

  const roi = expandVehicleRegion(selection.primary.box, metadata.width, metadata.height);
  const cropped = await sharp(normalized)
    .extract({ left: roi.x, top: roi.y, width: roi.width, height: roi.height })
    .toBuffer();
  const initialCutout = await removeBackground(cropped);
  const refined = await refineCutoutMask(
    initialCutout,
    {
      x: selection.primary.box.x - roi.x,
      y: selection.primary.box.y - roi.y,
      width: selection.primary.box.width,
      height: selection.primary.box.height,
    },
    selection.primary.confidence,
    selection.ambiguous,
  );
  const bytes = await sharp({
    create: {
      width: metadata.width,
      height: metadata.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: refined.bytes, left: roi.x, top: roi.y }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const aspectRatio = selection.primary.box.width / selection.primary.box.height;
  return {
    bytes,
    method: "vehicle_aware",
    detector: {
      model: VEHICLE_DETECTOR_VERSION,
      selected: selection.primary,
      candidateCount: selection.ranked.length,
      ambiguous: selection.ambiguous,
    },
    roi,
    quality: refined.quality,
    framing: { recommendedVehicleWidthRatio: aspectRatio >= 2.1 ? 0.76 : 0.82 },
  };
}
