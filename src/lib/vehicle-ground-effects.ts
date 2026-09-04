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

export type VehicleSilhouetteAnalysis = {
  bounds: SilhouetteBounds;
  contactBounds: { left: number; right: number; center: number };
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
  const y = groundBaseline - (bounds.bottom + 1) * scale;

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

  const silhouetteCenter = weightedX / Math.max(1, alphaPixels);
  const lowerCenter = lowerWeightedX / Math.max(1, lowerPixels);
  const lowerCenterOffset = clamp((lowerCenter - silhouetteCenter) / boundsWidth, -0.25, 0.25);
  const silhouetteAspect = boundsWidth / boundsHeight;
  const explicitView = classifyShotType(shotType);

  let view: VehicleView;
  let viewConfidence: number;
  if (explicitView) {
    view = explicitView;
    viewConfidence = 0.98;
  } else if (silhouetteAspect >= 1.92) {
    view = "side";
    viewConfidence = clamp(0.64 + (silhouetteAspect - 1.92) * 0.18, 0.64, 0.84);
  } else if (silhouetteAspect <= 1.42) {
    // The front and rear use the same conservative ground-effect geometry.
    view = "front";
    viewConfidence = clamp(0.6 + (1.42 - silhouetteAspect) * 0.2, 0.6, 0.76);
  } else {
    view = "three-quarter";
    viewConfidence = clamp(0.5 + Math.abs(lowerCenterOffset) * 1.1, 0.5, 0.68);
  }

  return {
    bounds: { top, bottom, left, right },
    contactBounds: {
      left: contactLeft,
      right: contactRight,
      center: (contactLeft + contactRight) / 2,
    },
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
        opacity: 3,
        scale: 82,
        widthFactor: 0.74,
        heightFactor: 0.2,
        blurFactor: 0.007,
        skew: 0,
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
        opacity: 10,
        scale: 94,
        widthFactor: 0.94,
        heightFactor: 0.34,
        blurFactor: 0.005,
        skew: clamp(direction * 0.4, -0.05, 0.05),
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
        opacity: 4,
        scale: 84,
        widthFactor: 0.8,
        heightFactor: 0.24,
        blurFactor: 0.007,
        skew: 0,
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
      opacity: 7,
      scale: 89,
      widthFactor: 0.87,
      heightFactor: 0.28,
      blurFactor: 0.006,
      skew: clamp(direction * 0.8, -0.14, 0.14),
    },
  };
}
