export type VehicleView =
  | "side"
  | "front"
  | "rear"
  | "front-three-quarter"
  | "rear-three-quarter"
  | "three-quarter"
  | "unknown";

export type SilhouetteBounds = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type VehicleContactZone = {
  left: number;
  right: number;
  center: number;
  groundY: number;
  strength: number;
};

export type SilhouetteContourPoint = { x: number; y: number };

export type VehicleSilhouetteAnalysis = {
  bounds: SilhouetteBounds;
  contactBounds: { left: number; right: number; center: number };
  contactZones: VehicleContactZone[];
  lowerContour: SilhouetteContourPoint[];
  groundY: number;
  view: VehicleView;
  viewConfidence: number;
  silhouetteAspect: number;
  lowerCenterOffset: number;
  alphaCoverage: number;
};

export type GroundEffectProfile = {
  view: VehicleView;
  confidence: number;
  shadow: {
    opacity: number;
    scale: number;
    widthFactor: number;
    depthFactor: number;
    blurFactor: number;
    skew: number;
  };
  reflection: {
    opacity: number;
    scale: number;
    widthFactor: number;
    heightFactor: number;
    blurFactor: number;
    skew: number;
    perspectiveTaper: number;
  };
};

export const PREPARED_IMAGE_WIDTH = 1600;
export const PREPARED_IMAGE_HEIGHT = 1200;

export type VehicleCompositionFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
  groundBaseline: number;
  visibleBounds: SilhouetteBounds;
};

export type GroundPlaneGeometry = {
  frame: VehicleCompositionFrame;
  baseline: number;
  vehicleLeft: number;
  vehicleRight: number;
  vehicleWidth: number;
  vehicleHeight: number;
  contactLeft: number;
  contactRight: number;
  contactCenter: number;
  contactZones: VehicleContactZone[];
  lowerContour: SilhouetteContourPoint[];
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Fit the visible alpha silhouette rather than the transparent source canvas.
 * Automatic cutouts intentionally retain source-sized transparent padding, so
 * centering the PNG rectangle itself makes the vehicle look small or off-axis.
 */
export function buildVehicleCompositionFrame(
  sourceWidth: number,
  sourceHeight: number,
  analysis: VehicleSilhouetteAnalysis,
  targetWidth = PREPARED_IMAGE_WIDTH,
  targetHeight = PREPARED_IMAGE_HEIGHT,
  options: { offsetXPct?: number; offsetYPct?: number; scalePct?: number } = {},
): VehicleCompositionFrame {
  const bounds =
    analysis.alphaCoverage > 0
      ? analysis.bounds
      : {
          top: 0,
          bottom: Math.max(0, sourceHeight - 1),
          left: 0,
          right: Math.max(0, sourceWidth - 1),
        };
  const visibleWidth = Math.max(1, bounds.right - bounds.left + 1);
  const visibleHeight = Math.max(1, bounds.bottom - bounds.top + 1);
  const fit =
    analysis.view === "side"
      ? { width: 0.84, height: 0.5, baseline: 0.74 }
      : analysis.view === "front" || analysis.view === "rear"
        ? { width: 0.68, height: 0.58, baseline: 0.74 }
        : analysis.view === "front-three-quarter" ||
            analysis.view === "rear-three-quarter" ||
            analysis.view === "three-quarter"
          ? { width: 0.79, height: 0.55, baseline: 0.74 }
          : { width: 0.73, height: 0.5, baseline: 0.72 };
  const confidenceScale = analysis.viewConfidence < 0.58 ? 0.94 : 1;
  const scale =
    Math.min(
      (targetWidth * fit.width * confidenceScale) / visibleWidth,
      (targetHeight * fit.height * confidenceScale) / visibleHeight,
    ) *
    (clamp(options.scalePct ?? 100, 25, 180) / 100);
  const visibleCenterX = (bounds.left + bounds.right + 1) / 2;
  const groundBaseline =
    targetHeight * fit.baseline + ((options.offsetYPct ?? 0) / 100) * targetHeight;
  const x =
    targetWidth / 2 - visibleCenterX * scale + ((options.offsetXPct ?? 0) / 100) * targetWidth;
  const sourceGroundY = analysis.alphaCoverage > 0 ? analysis.groundY : bounds.bottom;
  const y = groundBaseline - (sourceGroundY + 1) * scale;

  return {
    x,
    y,
    width: sourceWidth * scale,
    height: sourceHeight * scale,
    groundBaseline,
    visibleBounds: {
      top: y + bounds.top * scale,
      bottom: y + (bounds.bottom + 1) * scale,
      left: x + bounds.left * scale,
      right: x + (bounds.right + 1) * scale,
    },
  };
}

/**
 * Project the analyzed silhouette onto the same stage-space ground plane used
 * by automatic framing. Shadows and reflections consume this shared geometry
 * so car movement can never leave the effects anchored to stale PNG bounds.
 */
export function buildGroundPlaneGeometry(
  sourceWidth: number,
  sourceHeight: number,
  analysis: VehicleSilhouetteAnalysis,
  targetWidth = PREPARED_IMAGE_WIDTH,
  targetHeight = PREPARED_IMAGE_HEIGHT,
  options: { offsetXPct?: number; offsetYPct?: number; scalePct?: number } = {},
): GroundPlaneGeometry {
  const frame = buildVehicleCompositionFrame(
    sourceWidth,
    sourceHeight,
    analysis,
    targetWidth,
    targetHeight,
    options,
  );
  const scale = frame.width / Math.max(1, sourceWidth);
  const bounds = analysis.bounds;
  const projectX = (x: number) => frame.x + x * scale;
  const projectY = (y: number) => frame.y + y * scale;
  const contactZones = analysis.contactZones.map((zone) => ({
    ...zone,
    left: projectX(zone.left),
    right: projectX(zone.right + 1),
    center: projectX(zone.center),
    // A three-quarter shot has a near and far tire at different image-space
    // heights. Flattening every contact to one y-coordinate created a visible
    // gap under the farther tire. Preserve each observed contact height while
    // keeping the deepest contact on the shared composition baseline.
    groundY: projectY(zone.groundY + 1),
  }));

  return {
    frame,
    baseline: frame.groundBaseline,
    vehicleLeft: projectX(bounds.left),
    vehicleRight: projectX(bounds.right + 1),
    vehicleWidth: Math.max(1, (bounds.right - bounds.left + 1) * scale),
    vehicleHeight: Math.max(1, (bounds.bottom - bounds.top + 1) * scale),
    contactLeft: projectX(analysis.contactBounds.left),
    contactRight: projectX(analysis.contactBounds.right + 1),
    contactCenter: projectX(analysis.contactBounds.center),
    contactZones,
    lowerContour: analysis.lowerContour.map((point) => ({
      x: projectX(point.x),
      y: projectY(point.y),
    })),
  };
}

function classifyShotType(shotType: string | null | undefined): VehicleView | null {
  const label = (shotType ?? "")
    .toLowerCase()
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!label) return null;
  if (/front (3\/4|3 ?q|three quarter)/.test(label)) return "front-three-quarter";
  if (/rear (3\/4|3 ?q|three quarter)/.test(label)) return "rear-three-quarter";
  if (/driver side|passenger side|side profile|\bside\b/.test(label)) return "side";
  if (/\bfront\b/.test(label)) return "front";
  if (/\brear\b/.test(label)) return "rear";
  return null;
}

/**
 * Analyze a sampled RGBA cutout. The result intentionally uses shot
 * classification when available and only falls back to broad silhouette
 * groups; a mask alone cannot reliably distinguish a front from a rear view.
 */
export function analyzeVehicleAlpha(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  shotType?: string | null,
): VehicleSilhouetteAnalysis {
  const threshold = 32;
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  let alphaPixels = 0;
  let weightedX = 0;
  const bottomByX = new Int32Array(Math.max(1, width));
  bottomByX.fill(-1);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = rgba[(y * width + x) * 4 + 3] ?? 0;
      if (alpha <= threshold) continue;
      alphaPixels += 1;
      weightedX += x;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      left = Math.min(left, x);
      right = Math.max(right, x);
      bottomByX[x] = Math.max(bottomByX[x] ?? -1, y);
    }
  }

  if (bottom < top || right < left) {
    return {
      bounds: { top: 0, bottom: Math.max(0, height - 1), left: 0, right: Math.max(0, width - 1) },
      contactBounds: {
        left: 0,
        right: Math.max(0, width - 1),
        center: Math.max(0, width - 1) / 2,
      },
      contactZones: [],
      lowerContour: [],
      groundY: Math.max(0, height - 1),
      view: "unknown",
      viewConfidence: 0,
      silhouetteAspect: width / Math.max(1, height),
      lowerCenterOffset: 0,
      alphaCoverage: 0,
    };
  }

  const boundsWidth = Math.max(1, right - left + 1);
  const boundsHeight = Math.max(1, bottom - top + 1);
  const lowerStart = top + boundsHeight * 0.68;
  const contactStart = top + boundsHeight * 0.82;
  let lowerPixels = 0;
  let lowerWeightedX = 0;
  let contactLeft = right;
  let contactRight = left;

  for (let y = Math.floor(lowerStart); y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const alpha = rgba[(y * width + x) * 4 + 3] ?? 0;
      if (alpha <= threshold) continue;
      lowerPixels += 1;
      lowerWeightedX += x;
      if (y >= contactStart) {
        contactLeft = Math.min(contactLeft, x);
        contactRight = Math.max(contactRight, x);
      }
    }
  }

  if (contactRight < contactLeft) {
    contactLeft = left;
    contactRight = right;
  }

  const contourColumns = Array.from({ length: boundsWidth }, (_, index) => ({
    x: left + index,
    y: bottomByX[left + index] ?? -1,
  })).filter((point) => point.y >= 0);
  const sortedBottoms = contourColumns.map((point) => point.y).sort((a, b) => a - b);
  let groundY =
    sortedBottoms[Math.min(sortedBottoms.length - 1, Math.floor(sortedBottoms.length * 0.9))] ??
    bottom;
  const groundTolerance = Math.max(2, Math.round(boundsHeight * 0.045));
  const mergeGap = Math.max(1, Math.round(boundsWidth * 0.018));
  const minimumZoneWidth = Math.max(2, Math.round(boundsWidth * 0.018));
  const groundedColumns = contourColumns.filter((point) => point.y >= groundY - groundTolerance);
  const grouped: Array<{ left: number; right: number; ys: number[] }> = [];

  for (const point of groundedColumns) {
    const current = grouped.at(-1);
    if (!current || point.x - current.right > mergeGap + 1) {
      grouped.push({ left: point.x, right: point.x, ys: [point.y] });
    } else {
      current.right = point.x;
      current.ys.push(point.y);
    }
  }

  let contactZones = grouped
    .filter((zone) => zone.right - zone.left + 1 >= minimumZoneWidth)
    .map((zone): VehicleContactZone => {
      const zoneWidth = zone.right - zone.left + 1;
      const zoneGroundY = Math.max(...zone.ys);
      const verticalConfidence =
        zone.ys.reduce(
          (sum, value) => sum + clamp(1 - (groundY - value) / (groundTolerance + 1), 0, 1),
          0,
        ) / Math.max(1, zone.ys.length);
      return {
        left: zone.left,
        right: zone.right,
        center: (zone.left + zone.right) / 2,
        groundY: zoneGroundY,
        strength: clamp(verticalConfidence * Math.sqrt(zoneWidth / boundsWidth) * 2.4, 0.35, 1),
      };
    });

  if (contactZones.length === 0) {
    contactZones = [
      {
        left: contactLeft,
        right: contactRight,
        center: (contactLeft + contactRight) / 2,
        groundY,
        strength: 0.55,
      },
    ];
  } else if (contactZones.length > 4) {
    contactZones = contactZones
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 4)
      .sort((a, b) => a.left - b.left);
  }

  // Perspective frequently leaves the far wheel a few pixels above the
  // globally-lowest wheel. The old global threshold therefore returned one
  // contact lobe for a real three-quarter vehicle. Recover one local low point
  // from each half of the silhouette so contact shadow can attach at both
  // visible support regions without requiring wheel detection or ML.
  if (contactZones.length < 2 && boundsWidth >= 16) {
    const midpoint = Math.floor((left + right) / 2);
    const searchRanges = [
      { start: left, end: midpoint },
      { start: midpoint + 1, end: right },
    ];
    for (const range of searchRanges) {
      let peakX = range.start;
      let peakY = -1;
      for (let x = range.start; x <= range.end; x += 1) {
        if ((bottomByX[x] ?? -1) > peakY) {
          peakY = bottomByX[x] ?? -1;
          peakX = x;
        }
      }
      if (peakY < top + boundsHeight * 0.68) continue;
      if (contactZones.some((zone) => Math.abs(zone.center - peakX) < boundsWidth * 0.12)) continue;
      const halfSpan = Math.max(2, Math.round(boundsWidth * 0.045));
      contactZones.push({
        left: Math.max(left, peakX - halfSpan),
        right: Math.min(right, peakX + halfSpan),
        center: peakX,
        groundY: peakY,
        strength: 0.58,
      });
    }
    contactZones.sort((a, b) => a.left - b.left);
  }

  // Framing, reflection, and the deepest contact patch must use the same
  // physical baseline. This also guarantees that the visible car never hangs
  // below the plane while its effects begin above it.
  groundY = Math.max(groundY, ...contactZones.map((zone) => zone.groundY));

  contactLeft = Math.min(...contactZones.map((zone) => zone.left));
  contactRight = Math.max(...contactZones.map((zone) => zone.right));

  const contourBins = Math.min(36, boundsWidth);
  const lowerContour: SilhouetteContourPoint[] = [];
  for (let index = 0; index < contourBins; index += 1) {
    const binLeft = left + Math.floor((index * boundsWidth) / contourBins);
    const binRight = Math.min(
      right,
      left + Math.floor(((index + 1) * boundsWidth) / contourBins) - 1,
    );
    let binBottom = -1;
    let binBottomX = binLeft;
    for (let x = binLeft; x <= binRight; x += 1) {
      const value = bottomByX[x] ?? -1;
      if (value > binBottom) {
        binBottom = value;
        binBottomX = x;
      }
    }
    if (binBottom >= 0) lowerContour.push({ x: binBottomX, y: binBottom });
  }

  const silhouetteCenter = weightedX / Math.max(1, alphaPixels);
  const lowerCenter = lowerWeightedX / Math.max(1, lowerPixels);
  const lowerCenterOffset = clamp((lowerCenter - silhouetteCenter) / boundsWidth, -0.25, 0.25);
  const silhouetteAspect = boundsWidth / boundsHeight;
  const explicitView = classifyShotType(shotType);
  const contactDepthSpread =
    contactZones.length > 1
      ? (Math.max(...contactZones.map((zone) => zone.groundY)) -
          Math.min(...contactZones.map((zone) => zone.groundY))) /
        boundsHeight
      : 0;

  let view: VehicleView;
  let viewConfidence: number;
  if (explicitView) {
    view = explicitView;
    viewConfidence = 0.98;
  } else if (
    silhouetteAspect >= 1.92 &&
    Math.abs(lowerCenterOffset) < 0.055 &&
    contactDepthSpread < 0.04
  ) {
    view = "side";
    viewConfidence = clamp(0.64 + (silhouetteAspect - 1.92) * 0.18, 0.64, 0.84);
  } else if (silhouetteAspect <= 1.42) {
    // The front and rear use the same conservative ground-effect geometry.
    view = "front";
    viewConfidence = clamp(0.6 + (1.42 - silhouetteAspect) * 0.2, 0.6, 0.76);
  } else {
    view = "three-quarter";
    viewConfidence = clamp(0.5 + Math.abs(lowerCenterOffset) * 1.65, 0.5, 0.7);
  }

  return {
    bounds: { top, bottom, left, right },
    contactBounds: {
      left: contactLeft,
      right: contactRight,
      center: (contactLeft + contactRight) / 2,
    },
    contactZones,
    lowerContour,
    groundY,
    view,
    viewConfidence,
    silhouetteAspect,
    lowerCenterOffset,
    alphaCoverage: alphaPixels / Math.max(1, width * height),
  };
}

export function buildGroundEffectProfile(analysis: VehicleSilhouetteAnalysis): GroundEffectProfile {
  const direction = Math.abs(analysis.lowerCenterOffset) < 0.025 ? 0 : analysis.lowerCenterOffset;
  const conservative = analysis.viewConfidence < 0.58 || analysis.alphaCoverage < 0.015;

  if (conservative || analysis.view === "unknown") {
    return {
      view: analysis.view,
      confidence: analysis.viewConfidence,
      shadow: {
        opacity: 18,
        scale: 88,
        widthFactor: 0.78,
        depthFactor: 0.09,
        blurFactor: 0.022,
        skew: 0,
      },
      reflection: {
        opacity: 0,
        scale: 82,
        widthFactor: 0.74,
        heightFactor: 0.2,
        blurFactor: 0.007,
        skew: 0,
        perspectiveTaper: 0.18,
      },
    };
  }

  if (analysis.view === "side") {
    return {
      view: analysis.view,
      confidence: analysis.viewConfidence,
      shadow: {
        opacity: 26,
        scale: 96,
        widthFactor: 0.94,
        depthFactor: 0.1,
        blurFactor: 0.021,
        skew: clamp(direction * 0.35, -0.04, 0.04),
      },
      reflection: {
        opacity: 8,
        scale: 94,
        widthFactor: 0.94,
        heightFactor: 0.34,
        blurFactor: 0.005,
        skew: clamp(direction * 0.4, -0.05, 0.05),
        perspectiveTaper: 0.06,
      },
    };
  }

  if (analysis.view === "front" || analysis.view === "rear") {
    return {
      view: analysis.view,
      confidence: analysis.viewConfidence,
      shadow: {
        opacity: 23,
        scale: 88,
        widthFactor: 0.82,
        depthFactor: 0.11,
        blurFactor: 0.023,
        skew: 0,
      },
      reflection: {
        opacity: 3,
        scale: 84,
        widthFactor: 0.8,
        heightFactor: 0.21,
        blurFactor: 0.007,
        skew: 0,
        perspectiveTaper: 0.2,
      },
    };
  }

  return {
    view: analysis.view,
    confidence: analysis.viewConfidence,
    shadow: {
      opacity: 25,
      scale: 92,
      widthFactor: 0.88,
      depthFactor: 0.105,
      blurFactor: 0.022,
      skew: clamp(direction * 0.65, -0.11, 0.11),
    },
    reflection: {
      opacity: 5,
      scale: 89,
      widthFactor: 0.87,
      heightFactor: 0.25,
      blurFactor: 0.006,
      skew: clamp(direction * 0.8, -0.14, 0.14),
      perspectiveTaper: 0.13,
    },
  };
}
