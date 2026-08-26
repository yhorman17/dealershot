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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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
        opacity: 22,
        scale: 82,
        widthFactor: 0.74,
        depthFactor: 0.055,
        blurFactor: 0.018,
        skew: 0,
      },
      reflection: {
        opacity: 5,
        scale: 78,
        widthFactor: 0.76,
        heightFactor: 0.13,
        blurFactor: 0.006,
        skew: 0,
      },
    };
  }

  if (analysis.view === "side") {
    return {
      view: analysis.view,
      confidence: analysis.viewConfidence,
      shadow: {
        opacity: 32,
        scale: 96,
        widthFactor: 0.92,
        depthFactor: 0.07,
        blurFactor: 0.017,
        skew: clamp(direction * 0.35, -0.04, 0.04),
      },
      reflection: {
        opacity: 14,
        scale: 96,
        widthFactor: 0.96,
        heightFactor: 0.31,
        blurFactor: 0.004,
        skew: clamp(direction * 0.4, -0.05, 0.05),
      },
    };
  }

  if (analysis.view === "front" || analysis.view === "rear") {
    return {
      view: analysis.view,
      confidence: analysis.viewConfidence,
      shadow: {
        opacity: 27,
        scale: 84,
        widthFactor: 0.72,
        depthFactor: 0.06,
        blurFactor: 0.015,
        skew: 0,
      },
      reflection: {
        opacity: 7,
        scale: 82,
        widthFactor: 0.8,
        heightFactor: 0.17,
        blurFactor: 0.006,
        skew: 0,
      },
    };
  }

  return {
    view: analysis.view,
    confidence: analysis.viewConfidence,
    shadow: {
      opacity: 29,
      scale: 91,
      widthFactor: 0.84,
      depthFactor: 0.065,
      blurFactor: 0.016,
      skew: clamp(direction * 0.65, -0.11, 0.11),
    },
    reflection: {
      opacity: 10,
      scale: 89,
      widthFactor: 0.88,
      heightFactor: 0.22,
      blurFactor: 0.005,
      skew: clamp(direction * 0.8, -0.14, 0.14),
    },
  };
}
