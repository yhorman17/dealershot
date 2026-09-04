import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ProductSelect } from "@/components/product-ui";
import { MaskEditor } from "@/components/MaskEditor";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Scissors, X } from "lucide-react";
import { uploadPrivateVariant } from "@/lib/private-media";
import { removeVehicleBackground } from "@/lib/background-removal";
import {
  analyzeVehicleAlpha,
  buildVehicleCompositionFrame,
  buildGroundEffectProfile,
  buildGroundPlaneGeometry,
  PREPARED_IMAGE_HEIGHT,
  PREPARED_IMAGE_WIDTH,
  type GroundEffectProfile,
  type VehicleSilhouetteAnalysis,
} from "@/lib/vehicle-ground-effects";

export type Position = "top" | "bottom" | "tl" | "tr" | "bl" | "br";

const POSITIONS: { value: Position; label: string }[] = [
  { value: "top", label: "Top (full width)" },
  { value: "bottom", label: "Bottom (full width)" },
  { value: "tl", label: "Top-left corner" },
  { value: "tr", label: "Top-right corner" },
  { value: "bl", label: "Bottom-left corner" },
  { value: "br", label: "Bottom-right corner" },
];

type Backdrop = { id: string; name: string; image_url: string };
type OverlayTemplate = { id: string; name: string; image_url: string; category: string | null };

type Photo = {
  id: string;
  vehicle_id: string;
  image_url: string;
  shot_type: string | null;
  sort_order: number;
  is_main: boolean;
  is_cutout?: boolean;
  original_image_url?: string;
  cutout_image_url?: string | null;
  corrected_cutout_url?: string | null;
};

type TabKey = "background" | "adjust" | "shadow" | "reflection" | "overlay";

type AspectKey = "free" | "1:1" | "4:3" | "16:9" | "3:2";
type FitMode = "none" | "fit" | "fill" | "expand";
type CropRect = { x: number; y: number; w: number; h: number }; // normalized 0..1 of straightened source

const ASPECT_VALUE: Record<AspectKey, number | null> = {
  free: null,
  "1:1": 1,
  "4:3": 4 / 3,
  "16:9": 16 / 9,
  "3:2": 3 / 2,
};

// Defaults
const DEFAULTS = {
  shadowEnabled: true,
  shadowOpacity: 22,
  shadowScale: 82,
  shadowX: 0,
  shadowY: 0,
  reflectionEnabled: true,
  reflectionOpacity: 5,
  reflectionScale: 78,
  reflectionX: 0,
  reflectionY: 0,
  carX: 0,
  carY: 0,
  carScale: 100,
  adjustStraighten: 0,
  adjustAspect: "free" as AspectKey,
  adjustCrop: null as CropRect | null,
  adjustFit: "none" as FitMode,
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function destRect(baseW: number, baseH: number, ovW: number, ovH: number, pos: Position) {
  if (pos === "top" || pos === "bottom") {
    const w = baseW;
    const h = (ovH / ovW) * w;
    return { x: 0, y: pos === "top" ? 0 : baseH - h, w, h };
  }
  const w = baseW * 0.25;
  const h = (ovH / ovW) * w;
  const pad = baseW * 0.025;
  const x = pos === "tl" || pos === "bl" ? pad : baseW - w - pad;
  const y = pos === "tl" || pos === "tr" ? pad : baseH - h - pad;
  return { x, y, w, h };
}

type CarOpts = { offsetXPct: number; offsetYPct: number; scalePct: number };
const DEFAULT_CAR_OPTS: CarOpts = { offsetXPct: 0, offsetYPct: 0, scalePct: 100 };

function carRect(
  cutout: HTMLImageElement,
  analysis: VehicleSilhouetteAnalysis,
  targetW: number,
  targetH: number,
  opts: CarOpts = DEFAULT_CAR_OPTS,
) {
  const frame = buildVehicleCompositionFrame(
    cutout.naturalWidth,
    cutout.naturalHeight,
    analysis,
    targetW,
    targetH,
    opts,
  );
  return { x: frame.x, y: frame.y, w: frame.width, h: frame.height };
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  targetW: number,
  targetH: number,
) {
  const scale = Math.max(targetW / image.naturalWidth, targetH / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  ctx.drawImage(image, (targetW - width) / 2, (targetH - height) / 2, width, height);
}

function analyzeSilhouette(
  img: HTMLImageElement,
  shotType?: string | null,
): VehicleSilhouetteAnalysis {
  const sampleScale = Math.min(1, 720 / Math.max(img.naturalWidth, img.naturalHeight));
  const sampleWidth = Math.max(1, Math.round(img.naturalWidth * sampleScale));
  const sampleHeight = Math.max(1, Math.round(img.naturalHeight * sampleScale));
  const c = document.createElement("canvas");
  c.width = sampleWidth;
  c.height = sampleHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, sampleWidth, sampleHeight);
  const sampled = analyzeVehicleAlpha(
    ctx.getImageData(0, 0, sampleWidth, sampleHeight).data,
    sampleWidth,
    sampleHeight,
    shotType,
  );
  const toSource = 1 / sampleScale;
  return {
    ...sampled,
    bounds: {
      top: sampled.bounds.top * toSource,
      bottom: sampled.bounds.bottom * toSource,
      left: sampled.bounds.left * toSource,
      right: sampled.bounds.right * toSource,
    },
    contactBounds: {
      left: sampled.contactBounds.left * toSource,
      right: sampled.contactBounds.right * toSource,
      center: sampled.contactBounds.center * toSource,
    },
    contactZones: sampled.contactZones.map((zone) => ({
      ...zone,
      left: zone.left * toSource,
      right: zone.right * toSource,
      center: zone.center * toSource,
      groundY: zone.groundY * toSource,
    })),
    lowerContour: sampled.lowerContour.map((point) => ({
      x: point.x * toSource,
      y: point.y * toSource,
    })),
    groundY: sampled.groundY * toSource,
  };
}

function buildContactShadowCanvas(
  cutout: HTMLImageElement,
  analysis: VehicleSilhouetteAnalysis,
  profile: GroundEffectProfile,
  targetW: number,
  targetH: number,
  opacity: number,
  scalePct: number,
  offsetX: number,
  offsetY: number,
  carOpts: CarOpts,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = targetW;
  c.height = targetH;
  const ctx = c.getContext("2d")!;
  const geometry = buildGroundPlaneGeometry(
    cutout.naturalWidth,
    cutout.naturalHeight,
    analysis,
    targetW,
    targetH,
    carOpts,
  );
  const carWidth = geometry.vehicleWidth;
  const carHeight = geometry.vehicleHeight;
  const s = scalePct / 100;
  const groundY = geometry.baseline + offsetY;
  const centerX = geometry.contactCenter + offsetX;
  const widthScale = Math.max(0.25, profile.shadow.widthFactor * s);
  const shadowXFor = (x: number) => centerX + (x - geometry.contactCenter) * widthScale;
  const ambientWidth =
    Math.min(
      carWidth * 0.98,
      Math.max(geometry.contactRight - geometry.contactLeft, carWidth * 0.62),
    ) * widthScale;
  const depth = Math.max(18, carHeight * profile.shadow.depthFactor * s);
  const ambientLayer = document.createElement("canvas");
  ambientLayer.width = targetW;
  ambientLayer.height = targetH;
  const ambient = ambientLayer.getContext("2d")!;
  const contour = geometry.lowerContour;

  // The ambient layer follows the sampled lower hull instead of using a stock
  // oval. The vehicle is drawn later, hiding the small overlap and leaving a
  // soft floor projection that starts at the same baseline as tire contact.
  if (contour.length >= 2) {
    ambient.save();
    ambient.beginPath();
    const first = contour[0]!;
    ambient.moveTo(shadowXFor(first.x), Math.min(groundY, first.y + offsetY));
    for (const point of contour) {
      ambient.lineTo(shadowXFor(point.x), Math.min(groundY, point.y + offsetY));
    }
    for (let index = contour.length - 1; index >= 0; index -= 1) {
      const point = contour[index]!;
      const distance = Math.abs(point.x - centerX) / Math.max(1, ambientWidth / 2);
      const perspectiveDepth = depth * (0.42 + 0.58 * Math.max(0, 1 - distance * distance));
      const drift = profile.shadow.skew * perspectiveDepth;
      ambient.lineTo(shadowXFor(point.x) + drift, groundY + perspectiveDepth);
    }
    ambient.closePath();
    const fill = ambient.createLinearGradient(0, groundY - depth * 0.1, 0, groundY + depth);
    fill.addColorStop(0, `rgba(0,0,0,${opacity * 0.34})`);
    fill.addColorStop(0.32, `rgba(0,0,0,${opacity * 0.2})`);
    fill.addColorStop(1, "rgba(0,0,0,0)");
    ambient.fillStyle = fill;
    ambient.fill();
    ambient.restore();

    ctx.save();
    ctx.filter = `blur(${Math.max(5, carWidth * profile.shadow.blurFactor).toFixed(2)}px)`;
    ctx.drawImage(ambientLayer, 0, 0);
    ctx.restore();
  }

  // Each robust low-point cluster gets its own tight contact patch. These are
  // deliberately darker and shallower than the ambient layer so tires and the
  // rocker panel visually meet the floor rather than floating above a bar.
  const zones = geometry.contactZones.length
    ? geometry.contactZones
    : [
        {
          left: geometry.contactLeft,
          right: geometry.contactRight,
          center: geometry.contactCenter,
          groundY,
          strength: 0.55,
        },
      ];
  for (const zone of zones) {
    const zoneSpan = Math.max(1, zone.right - zone.left) * widthScale;
    const zoneWidth = Math.min(
      carWidth * 0.34,
      Math.max(
        zoneSpan * 1.45,
        carWidth * (profile.view === "front" || profile.view === "rear" ? 0.17 : 0.11),
      ),
    );
    const zoneDepth = Math.max(
      7,
      carHeight * (profile.view === "front" || profile.view === "rear" ? 0.034 : 0.026) * s,
    );
    const zoneCenter = shadowXFor(zone.center);
    ctx.save();
    ctx.translate(zoneCenter, groundY + zoneDepth * 0.08);
    ctx.scale(1, zoneDepth / Math.max(1, zoneWidth));
    const contact = ctx.createRadialGradient(0, 0, 0, 0, 0, zoneWidth * 0.52);
    contact.addColorStop(0, `rgba(0,0,0,${opacity * (0.76 + zone.strength * 0.2)})`);
    contact.addColorStop(0.48, `rgba(0,0,0,${opacity * 0.42})`);
    contact.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = contact;
    ctx.beginPath();
    ctx.arc(0, 0, zoneWidth * 0.52, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  return c;
}

function buildReflectionCanvas(
  cutout: HTMLImageElement,
  analysis: VehicleSilhouetteAnalysis,
  profile: GroundEffectProfile,
  targetW: number,
  targetH: number,
  intensity: number,
  offsetX: number,
  offsetY: number,
  scalePct: number,
  carOpts: CarOpts,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = targetW;
  c.height = targetH;
  const ctx = c.getContext("2d")!;
  const geometry = buildGroundPlaneGeometry(
    cutout.naturalWidth,
    cutout.naturalHeight,
    analysis,
    targetW,
    targetH,
    carOpts,
  );
  const bounds = analysis.bounds;
  const silW = geometry.vehicleWidth;
  const silH = geometry.vehicleHeight;
  const groundY = geometry.baseline + offsetY;
  const s = Math.max(0.1, scalePct / 100);
  const vehicleCenter = (geometry.vehicleLeft + geometry.vehicleRight) / 2;
  const footprintWeight = profile.view.includes("three-quarter") ? 0.48 : 0.22;
  const centerX =
    vehicleCenter * (1 - footprintWeight) + geometry.contactCenter * footprintWeight + offsetX;
  const reflectionW = Math.min(silW, silW * profile.reflection.widthFactor * s);
  const reflectionH = Math.max(6, silH * profile.reflection.heightFactor * s);
  const reflectionLayer = document.createElement("canvas");
  reflectionLayer.width = targetW;
  reflectionLayer.height = targetH;
  const reflectionContext = reflectionLayer.getContext("2d")!;
  const sourceW = Math.max(1, bounds.right - bounds.left + 1);
  const sourceH = Math.max(1, bounds.bottom - bounds.top + 1);
  const slices = Math.min(72, Math.max(32, Math.round(sourceH / 8)));

  // Warp horizontal silhouette slices independently. The bottom-most source
  // pixels touch the shared baseline; slices taper and drift with distance so
  // three-quarter views read as a floor projection, not a mirrored rectangle.
  for (let index = 0; index < slices; index += 1) {
    const near = index / slices;
    const far = (index + 1) / slices;
    const sourceTop = bounds.bottom + 1 - far * sourceH;
    const sourceHeight = Math.max(1, (far - near) * sourceH + 0.75);
    const distance = (near + far) / 2;
    const sliceWidth = reflectionW * (1 - profile.reflection.perspectiveTaper * distance);
    const drift = profile.reflection.skew * reflectionH * distance;
    const destinationY = groundY - 0.5 + near * reflectionH;
    const destinationHeight = Math.max(1.4, (far - near) * reflectionH + 1);
    reflectionContext.drawImage(
      cutout,
      bounds.left,
      sourceTop,
      sourceW,
      sourceHeight,
      centerX - sliceWidth / 2 + drift,
      destinationY,
      sliceWidth,
      destinationHeight,
    );
  }

  reflectionContext.globalCompositeOperation = "destination-in";
  const fadeEnd = Math.min(targetH, groundY + reflectionH);
  const grad = reflectionContext.createLinearGradient(0, groundY, 0, fadeEnd);
  grad.addColorStop(0, `rgba(0,0,0,${intensity})`);
  grad.addColorStop(0.42, `rgba(0,0,0,${intensity * 0.34})`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  reflectionContext.fillStyle = grad;
  reflectionContext.fillRect(0, groundY, targetW, Math.max(1, reflectionH));

  const baseBlur = Math.max(0.8, silW * profile.reflection.blurFactor);
  const bands = 5;
  for (let index = 0; index < bands; index += 1) {
    const bandY = groundY + (index / bands) * reflectionH;
    const bandHeight = reflectionH / bands;
    const padding = Math.ceil(baseBlur * 3);
    ctx.save();
    ctx.filter = `blur(${(baseBlur * (0.72 + index * 0.24)).toFixed(2)}px)`;
    ctx.drawImage(
      reflectionLayer,
      0,
      Math.max(0, bandY - padding),
      targetW,
      Math.min(targetH - Math.max(0, bandY - padding), bandHeight + padding * 2),
      0,
      Math.max(0, bandY - padding),
      targetW,
      Math.min(targetH - Math.max(0, bandY - padding), bandHeight + padding * 2),
    );
    ctx.restore();
  }
  return c;
}

type ComposeOpts = {
  cutout: HTMLImageElement;
  analysis: VehicleSilhouetteAnalysis;
  groundEffectProfile: GroundEffectProfile;
  backdrop: HTMLImageElement;
  overlay: HTMLImageElement | null;
  overlayPos: Position;
  targetW: number;
  targetH: number;
  shadowEnabled: boolean;
  shadowOpacity: number;
  shadowScale: number;
  shadowX: number;
  shadowY: number;
  reflectionEnabled: boolean;
  reflectionOpacity: number;
  reflectionScale: number;
  reflectionX: number;
  reflectionY: number;
  carOpts: CarOpts;
};

function compose(ctx: CanvasRenderingContext2D, o: ComposeOpts) {
  const { targetW, targetH } = o;
  ctx.clearRect(0, 0, targetW, targetH);

  drawImageCover(ctx, o.backdrop, targetW, targetH);

  if (o.reflectionEnabled && o.reflectionOpacity > 0) {
    const ref = buildReflectionCanvas(
      o.cutout,
      o.analysis,
      o.groundEffectProfile,
      targetW,
      targetH,
      o.reflectionOpacity,
      o.reflectionX,
      o.reflectionY,
      o.reflectionScale,
      o.carOpts,
    );
    ctx.drawImage(ref, 0, 0);
  }

  if (o.shadowEnabled && o.shadowOpacity > 0) {
    const sh = buildContactShadowCanvas(
      o.cutout,
      o.analysis,
      o.groundEffectProfile,
      targetW,
      targetH,
      o.shadowOpacity,
      o.shadowScale,
      o.shadowX,
      o.shadowY,
      o.carOpts,
    );
    ctx.drawImage(sh, 0, 0);
  }

  const r = carRect(o.cutout, o.analysis, targetW, targetH, o.carOpts);
  ctx.drawImage(o.cutout, r.x, r.y, r.w, r.h);

  if (o.overlay) {
    const dr = destRect(
      targetW,
      targetH,
      o.overlay.naturalWidth,
      o.overlay.naturalHeight,
      o.overlayPos,
    );
    ctx.drawImage(o.overlay, dr.x, dr.y, dr.w, dr.h);
  }
}

/**
 * Produce a baked source image as a data URL by applying straighten,
 * crop, fit, and target aspect to the original. Returns null if no
 * transformation is needed (caller should use the original src).
 */
function buildProcessedDataURL(
  original: HTMLImageElement,
  straighten: number,
  crop: CropRect | null,
  aspect: AspectKey,
  fit: FitMode,
): string | null {
  const noop = straighten === 0 && crop === null && fit === "none" && aspect === "free";
  if (noop) return null;

  const ow = original.naturalWidth;
  const oh = original.naturalHeight;

  // Step 1: straighten (rotate around center, keep same canvas size; transparent corners)
  const sCanvas = document.createElement("canvas");
  sCanvas.width = ow;
  sCanvas.height = oh;
  const sCtx = sCanvas.getContext("2d")!;
  if (straighten !== 0) {
    sCtx.translate(ow / 2, oh / 2);
    sCtx.rotate((straighten * Math.PI) / 180);
    sCtx.drawImage(original, -ow / 2, -oh / 2);
    sCtx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    sCtx.drawImage(original, 0, 0);
  }

  // Step 2: crop (normalized to straightened canvas)
  let cropped: HTMLCanvasElement = sCanvas;
  if (crop && crop.w > 0 && crop.h > 0) {
    const cx = Math.max(0, Math.round(crop.x * ow));
    const cy = Math.max(0, Math.round(crop.y * oh));
    const cw = Math.min(ow - cx, Math.round(crop.w * ow));
    const ch = Math.min(oh - cy, Math.round(crop.h * oh));
    const cCanvas = document.createElement("canvas");
    cCanvas.width = cw;
    cCanvas.height = ch;
    cCanvas.getContext("2d")!.drawImage(sCanvas, cx, cy, cw, ch, 0, 0, cw, ch);
    cropped = cCanvas;
  }

  // Step 3: fit/aspect
  const targetAspect = ASPECT_VALUE[aspect];
  if (fit === "none" || targetAspect === null) {
    return cropped.toDataURL("image/png");
  }

  const srcW = cropped.width;
  const srcH = cropped.height;
  const srcAspect = srcW / srcH;
  let outW: number;
  let outH: number;
  const fitMode = fit;

  if (fitMode === "fill") {
    // crop to fill target aspect
    if (srcAspect > targetAspect) {
      outH = srcH;
      outW = srcH * targetAspect;
    } else {
      outW = srcW;
      outH = srcW / targetAspect;
    }
    const out = document.createElement("canvas");
    out.width = Math.round(outW);
    out.height = Math.round(outH);
    const dx = (outW - srcW) / 2;
    const dy = (outH - srcH) / 2;
    out.getContext("2d")!.drawImage(cropped, dx, dy);
    return out.toDataURL("image/png");
  }

  // fit (letterbox) or expand: pad to reach target aspect; expand uses larger dim
  if (fitMode === "expand") {
    if (srcAspect > targetAspect) {
      outW = srcW;
      outH = srcW / targetAspect;
    } else {
      outH = srcH;
      outW = srcH * targetAspect;
    }
  } else {
    // fit
    if (srcAspect > targetAspect) {
      outW = srcW;
      outH = srcW / targetAspect;
    } else {
      outH = srcH;
      outW = srcH * targetAspect;
    }
  }
  const out = document.createElement("canvas");
  out.width = Math.round(outW);
  out.height = Math.round(outH);
  const octx = out.getContext("2d")!;
  octx.drawImage(cropped, (outW - srcW) / 2, (outH - srcH) / 2);
  return out.toDataURL("image/png");
}

type Snapshot = {
  backdropId: string;
  overlayId: string;
  overlayPos: Position;
  shadowEnabled: boolean;
  shadowOpacity: number;
  shadowScale: number;
  shadowX: number;
  shadowY: number;
  reflectionEnabled: boolean;
  reflectionOpacity: number;
  reflectionScale: number;
  reflectionX: number;
  reflectionY: number;
  carX: number;
  carY: number;
  carScale: number;
  adjustStraighten: number;
  adjustAspect: AspectKey;
  adjustCrop: CropRect | null;
  adjustFit: FitMode;
};

export function BackgroundEditor({
  photo,
  dealershipId,
  onClose,
  onSaved,
}: {
  photo: Photo;
  dealershipId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [backdrops, setBackdrops] = useState<Backdrop[]>([]);
  const [overlays, setOverlays] = useState<OverlayTemplate[]>([]);
  const [defaultBackdropId, setDefaultBackdropId] = useState<string>("");
  const [backdropId, setBackdropId] = useState<string>("");
  const [overlayId, setOverlayId] = useState<string>("");
  const [overlayPos, setOverlayPos] = useState<Position>("bottom");
  const [originalImg, setOriginalImg] = useState<HTMLImageElement | null>(null);
  const [rawCutoutImg, setRawCutoutImg] = useState<HTMLImageElement | null>(null);
  const [cutoutImg, setCutoutImg] = useState<HTMLImageElement | null>(null);
  const [backdropImg, setBackdropImg] = useState<HTMLImageElement | null>(null);
  const [overlayImg, setOverlayImg] = useState<HTMLImageElement | null>(null);
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeProgress, setRemoveProgress] = useState<number | null>(null);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comparePosition, setComparePosition] = useState(50);
  const [activeTab, setActiveTab] = useState<TabKey>("background");
  const [maskOpen, setMaskOpen] = useState(false);
  const pendingCutoutBlobRef = useRef<Blob | null>(null);
  const sourceBlobRef = useRef<Blob | null>(null);
  const removeInFlightRef = useRef(false);

  // Compositing state
  const [shadowEnabled, setShadowEnabled] = useState(DEFAULTS.shadowEnabled);
  const [shadowOpacity, setShadowOpacity] = useState(DEFAULTS.shadowOpacity);
  const [shadowScale, setShadowScale] = useState(DEFAULTS.shadowScale);
  const [shadowX, setShadowX] = useState(DEFAULTS.shadowX);
  const [shadowY, setShadowY] = useState(DEFAULTS.shadowY);
  const [reflectionEnabled, setReflectionEnabled] = useState(DEFAULTS.reflectionEnabled);
  const [reflectionOpacity, setReflectionOpacity] = useState(DEFAULTS.reflectionOpacity);
  const [reflectionScale, setReflectionScale] = useState(DEFAULTS.reflectionScale);
  const [reflectionX, setReflectionX] = useState(DEFAULTS.reflectionX);
  const [reflectionY, setReflectionY] = useState(DEFAULTS.reflectionY);
  const [carX, setCarX] = useState(DEFAULTS.carX);
  const [carY, setCarY] = useState(DEFAULTS.carY);
  const [carScale, setCarScale] = useState(DEFAULTS.carScale);
  const [carPosOpen, setCarPosOpen] = useState(true);

  // Adjust tab state
  const [adjustStraighten, setAdjustStraighten] = useState(DEFAULTS.adjustStraighten);
  const [adjustAspect, setAdjustAspect] = useState<AspectKey>(DEFAULTS.adjustAspect);
  const [adjustCrop, setAdjustCrop] = useState<CropRect | null>(DEFAULTS.adjustCrop);
  const [adjustFit, setAdjustFit] = useState<FitMode>(DEFAULTS.adjustFit);
  // pending crop selection (drag) in normalized coords relative to the displayed preview
  const [pendingCrop, setPendingCrop] = useState<CropRect | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const cutoutUrlRef = useRef<string | null>(null);
  const originalObjectUrlRef = useRef<string | null>(null);
  const groundEffectsEditedRef = useRef(false);
  const appliedGroundEffectsSourceRef = useRef<string | null>(null);

  // Undo history
  const historyRef = useRef<Snapshot[]>([]);
  const suppressHistoryRef = useRef(false);
  const [historyLen, setHistoryLen] = useState(0);

  const silhouetteAnalysis = useMemo(
    () => (cutoutImg ? analyzeSilhouette(cutoutImg, photo.shot_type) : null),
    [cutoutImg, photo.shot_type],
  );
  const groundEffectProfile = useMemo(
    () => (silhouetteAnalysis ? buildGroundEffectProfile(silhouetteAnalysis) : null),
    [silhouetteAnalysis],
  );

  useEffect(() => {
    if (!rawCutoutImg || !groundEffectProfile || groundEffectsEditedRef.current) return;
    const sourceKey = rawCutoutImg.src;
    if (appliedGroundEffectsSourceRef.current === sourceKey) return;

    appliedGroundEffectsSourceRef.current = sourceKey;
    suppressHistoryRef.current = true;
    setShadowOpacity(groundEffectProfile.shadow.opacity);
    setShadowScale(groundEffectProfile.shadow.scale);
    setShadowX(DEFAULTS.shadowX);
    setShadowY(DEFAULTS.shadowY);
    setReflectionOpacity(groundEffectProfile.reflection.opacity);
    setReflectionScale(groundEffectProfile.reflection.scale);
    setReflectionX(DEFAULTS.reflectionX);
    setReflectionY(DEFAULTS.reflectionY);
    const release = window.setTimeout(() => {
      suppressHistoryRef.current = false;
    }, 0);
    return () => window.clearTimeout(release);
  }, [groundEffectProfile, rawCutoutImg]);

  const snapshot = useCallback(
    (): Snapshot => ({
      backdropId,
      overlayId,
      overlayPos,
      shadowEnabled,
      shadowOpacity,
      shadowScale,
      shadowX,
      shadowY,
      reflectionEnabled,
      reflectionOpacity,
      reflectionScale,
      reflectionX,
      reflectionY,
      carX,
      carY,
      carScale,
      adjustStraighten,
      adjustAspect,
      adjustCrop,
      adjustFit,
    }),
    [
      backdropId,
      overlayId,
      overlayPos,
      shadowEnabled,
      shadowOpacity,
      shadowScale,
      shadowX,
      shadowY,
      reflectionEnabled,
      reflectionOpacity,
      reflectionScale,
      reflectionX,
      reflectionY,
      carX,
      carY,
      carScale,
      adjustStraighten,
      adjustAspect,
      adjustCrop,
      adjustFit,
    ],
  );

  const applySnapshot = (s: Snapshot) => {
    suppressHistoryRef.current = true;
    setBackdropId(s.backdropId);
    setOverlayId(s.overlayId);
    setOverlayPos(s.overlayPos);
    setShadowEnabled(s.shadowEnabled);
    setShadowOpacity(s.shadowOpacity);
    setShadowScale(s.shadowScale);
    setShadowX(s.shadowX);
    setShadowY(s.shadowY);
    setReflectionEnabled(s.reflectionEnabled);
    setReflectionOpacity(s.reflectionOpacity);
    setReflectionScale(s.reflectionScale);
    setReflectionX(s.reflectionX);
    setReflectionY(s.reflectionY);
    setCarX(s.carX);
    setCarY(s.carY);
    setCarScale(s.carScale);
    setAdjustStraighten(s.adjustStraighten);
    setAdjustAspect(s.adjustAspect);
    setAdjustCrop(s.adjustCrop);
    setAdjustFit(s.adjustFit);
    setTimeout(() => {
      suppressHistoryRef.current = false;
    }, 0);
  };

  const recordHistory = () => {
    if (suppressHistoryRef.current) return;
    historyRef.current.push(snapshot());
    if (historyRef.current.length > 20) historyRef.current.shift();
    setHistoryLen(historyRef.current.length);
  };

  // Tracked setter wrapper: pushes current state onto history before applying change.
  function track<T>(setter: (v: T) => void): (v: T) => void {
    return (v: T) => {
      recordHistory();
      setter(v);
    };
  }

  // Ground effects begin with silhouette-aware defaults, but any direct user
  // adjustment owns the value for the rest of this editor session.
  function trackGroundEffect<T>(setter: (v: T) => void): (v: T) => void {
    return (v: T) => {
      groundEffectsEditedRef.current = true;
      track(setter)(v);
    };
  }

  const undo = () => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    setHistoryLen(historyRef.current.length);
    applySnapshot(prev);
  };

  const resetCompositing = () => {
    recordHistory();
    groundEffectsEditedRef.current = false;
    setShadowEnabled(DEFAULTS.shadowEnabled);
    setShadowOpacity(groundEffectProfile?.shadow.opacity ?? DEFAULTS.shadowOpacity);
    setShadowScale(groundEffectProfile?.shadow.scale ?? DEFAULTS.shadowScale);
    setShadowX(DEFAULTS.shadowX);
    setShadowY(DEFAULTS.shadowY);
    setReflectionEnabled(DEFAULTS.reflectionEnabled);
    setReflectionOpacity(groundEffectProfile?.reflection.opacity ?? DEFAULTS.reflectionOpacity);
    setReflectionScale(groundEffectProfile?.reflection.scale ?? DEFAULTS.reflectionScale);
    setReflectionX(DEFAULTS.reflectionX);
    setReflectionY(DEFAULTS.reflectionY);
  };

  const resetAdjust = () => {
    recordHistory();
    setAdjustStraighten(DEFAULTS.adjustStraighten);
    setAdjustAspect(DEFAULTS.adjustAspect);
    setAdjustCrop(DEFAULTS.adjustCrop);
    setAdjustFit(DEFAULTS.adjustFit);
    setPendingCrop(null);
  };

  const resetShadow = () => {
    recordHistory();
    groundEffectsEditedRef.current = false;
    setShadowEnabled(DEFAULTS.shadowEnabled);
    setShadowOpacity(groundEffectProfile?.shadow.opacity ?? DEFAULTS.shadowOpacity);
    setShadowScale(groundEffectProfile?.shadow.scale ?? DEFAULTS.shadowScale);
    setShadowX(DEFAULTS.shadowX);
    setShadowY(DEFAULTS.shadowY);
  };
  const resetReflection = () => {
    recordHistory();
    groundEffectsEditedRef.current = false;
    setReflectionEnabled(DEFAULTS.reflectionEnabled);
    setReflectionOpacity(groundEffectProfile?.reflection.opacity ?? DEFAULTS.reflectionOpacity);
    setReflectionScale(groundEffectProfile?.reflection.scale ?? DEFAULTS.reflectionScale);
    setReflectionX(DEFAULTS.reflectionX);
    setReflectionY(DEFAULTS.reflectionY);
  };

  const resetBackground = () => {
    recordHistory();
    setBackdropId(defaultBackdropId);
    setCarX(DEFAULTS.carX);
    setCarY(DEFAULTS.carY);
    setCarScale(DEFAULTS.carScale);
  };

  const resetCurrentTab = () => {
    if (activeTab === "background") resetBackground();
    else if (activeTab === "adjust") resetAdjust();
    else if (activeTab === "shadow") resetShadow();
    else if (activeTab === "reflection") resetReflection();
    else if (activeTab === "overlay") {
      recordHistory();
      setOverlayId("");
      setOverlayPos("bottom");
    }
  };

  useEffect(() => {
    void (async () => {
      const [{ data: bs }, { data: os }] = await Promise.all([
        supabase
          .from("backdrops")
          .select("id, name, image_url")
          .eq("dealership_id", dealershipId)
          .order("created_at", { ascending: false }),
        supabase
          .from("overlay_templates")
          .select("id, name, image_url, category")
          .eq("dealership_id", dealershipId)
          .order("created_at", { ascending: false }),
      ]);
      const bList = (bs as Backdrop[]) || [];
      const oList = (os as OverlayTemplate[]) || [];
      setBackdrops(bList);
      setOverlays(oList);
      if (bList.length > 0) {
        suppressHistoryRef.current = true;
        setBackdropId(bList[0].id);
        setDefaultBackdropId(bList[0].id);
        setTimeout(() => {
          suppressHistoryRef.current = false;
        }, 0);
      }
    })();
  }, [dealershipId]);

  const originalUrl = photo.original_image_url || photo.image_url;
  const persistedCutoutUrl =
    photo.corrected_cutout_url ||
    photo.cutout_image_url ||
    (photo.is_cutout ? photo.image_url : null);

  // Materialize the authorized private source into memory once. The editor can
  // then outlive the signed delivery URL without losing its working preview.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const response = await fetch(originalUrl, { mode: "cors", credentials: "omit" });
        if (!response.ok) throw new Error(`Source request failed (${response.status}).`);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const image = await loadImage(objectUrl);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        if (originalObjectUrlRef.current) URL.revokeObjectURL(originalObjectUrlRef.current);
        originalObjectUrlRef.current = objectUrl;
        sourceBlobRef.current = blob;
        setOriginalImg(image);
      } catch (reason) {
        console.error("[bg-editor] private source initialization failed", {
          photoId: photo.id,
          reason,
        });
        if (!cancelled) setError("Original photo could not be loaded. Close Customize and retry.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [originalUrl, photo.id]);

  // Load an existing cutout when present. Background removal itself is only
  // imported and invoked by the explicit Remove Background action below.
  useEffect(() => {
    let cancelled = false;
    setRemoveErr(null);
    void (async () => {
      try {
        if (!persistedCutoutUrl) {
          setRawCutoutImg(null);
          return;
        }
        const image = await loadImage(persistedCutoutUrl);
        if (!cancelled) setRawCutoutImg(image);
      } catch (err) {
        if (!cancelled)
          setRemoveErr(
            err instanceof Error ? err.message : "The saved cutout could not be loaded.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistedCutoutUrl]);

  const createCutout = async () => {
    if (removeInFlightRef.current) return;
    const sourceBlob = sourceBlobRef.current;
    if (!sourceBlob) {
      setRemoveErr("The photo is still loading. Wait a moment and try again.");
      return;
    }
    removeInFlightRef.current = true;
    setRemoving(true);
    setRemoveProgress(0);
    setRemoveErr(null);
    try {
      const blob = await removeVehicleBackground(sourceBlob, (_key, current, total) => {
        if (total > 0) setRemoveProgress(Math.min(100, Math.round((current / total) * 100)));
      });
      pendingCutoutBlobRef.current = blob;
      const url = URL.createObjectURL(blob);
      if (cutoutUrlRef.current) URL.revokeObjectURL(cutoutUrlRef.current);
      cutoutUrlRef.current = url;
      setRawCutoutImg(await loadImage(url));
    } catch (reason) {
      console.error("[bg-editor] background removal failed", { photoId: photo.id, reason });
      setRemoveErr("Background removal failed. Your original photo was not changed. Try again.");
    } finally {
      removeInFlightRef.current = false;
      setRemoving(false);
      setRemoveProgress(null);
    }
  };

  const applyCorrectedMask = async (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    try {
      const correctedImage = await loadImage(url);
      const previousUrl = cutoutUrlRef.current;
      pendingCutoutBlobRef.current = blob;
      cutoutUrlRef.current = url;
      setRawCutoutImg(correctedImage);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    } catch (reason) {
      URL.revokeObjectURL(url);
      throw reason;
    }
  };

  useEffect(() => {
    return () => {
      if (cutoutUrlRef.current) URL.revokeObjectURL(cutoutUrlRef.current);
      if (originalObjectUrlRef.current) URL.revokeObjectURL(originalObjectUrlRef.current);
    };
  }, []);

  // Apply adjust transforms to the cached cutout (debounced).
  // Preserves alpha — never re-runs the removal model.
  useEffect(() => {
    if (!rawCutoutImg) return;
    let cancelled = false;
    const t = setTimeout(() => {
      try {
        const url = buildProcessedDataURL(
          rawCutoutImg,
          adjustStraighten,
          adjustCrop,
          adjustAspect,
          adjustFit,
        );
        if (url === null) {
          if (cancelled) return;
          setCutoutImg(rawCutoutImg);
          setBaseSize({ w: rawCutoutImg.naturalWidth, h: rawCutoutImg.naturalHeight });
          return;
        }
        void loadImage(url)
          .then((img) => {
            if (cancelled) return;
            setCutoutImg(img);
            setBaseSize({ w: img.naturalWidth, h: img.naturalHeight });
          })
          .catch((err) => {
            // Don't tear down the editor on a bad transform — log and keep the last good cutout.
            console.warn("[bg-editor] adjust bake failed", err);
          });
      } catch (err) {
        console.warn("[bg-editor] adjust bake failed", err);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [rawCutoutImg, adjustStraighten, adjustCrop, adjustAspect, adjustFit]);

  useEffect(() => {
    const sel = backdrops.find((b) => b.id === backdropId);
    if (!sel) {
      setBackdropImg(null);
      return;
    }
    let cancelled = false;
    void loadImage(sel.image_url).then((img) => {
      if (!cancelled) setBackdropImg(img);
    });
    return () => {
      cancelled = true;
    };
  }, [backdropId, backdrops]);

  useEffect(() => {
    const sel = overlays.find((o) => o.id === overlayId);
    if (!sel) {
      setOverlayImg(null);
      return;
    }
    let cancelled = false;
    void loadImage(sel.image_url).then((img) => {
      if (!cancelled) setOverlayImg(img);
    });
    return () => {
      cancelled = true;
    };
  }, [overlayId, overlays]);

  // One persistent preview canvas serves every control tab. Before a cutout is
  // available it deliberately renders the immutable source; after removal it
  // renders the same cutout/composition while tabs only change controls.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !originalImg) return;
    const targetSize = { w: PREPARED_IMAGE_WIDTH, h: PREPARED_IMAGE_HEIGHT };
    canvas.width = targetSize.w;
    canvas.height = targetSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, targetSize.w, targetSize.h);

    if (cutoutImg && silhouetteAnalysis && groundEffectProfile) {
      if (backdropImg) {
        compose(ctx, {
          cutout: cutoutImg,
          analysis: silhouetteAnalysis,
          groundEffectProfile,
          backdrop: backdropImg,
          overlay: overlayImg,
          overlayPos,
          targetW: targetSize.w,
          targetH: targetSize.h,
          shadowEnabled,
          shadowOpacity: shadowOpacity / 100,
          shadowScale,
          shadowX,
          shadowY,
          reflectionEnabled,
          reflectionOpacity: reflectionOpacity / 100,
          reflectionScale,
          reflectionX,
          reflectionY,
          carOpts: { offsetXPct: carX, offsetYPct: carY, scalePct: carScale },
        });
      } else {
        const rect = carRect(cutoutImg, silhouetteAnalysis, targetSize.w, targetSize.h, {
          offsetXPct: carX,
          offsetYPct: carY,
          scalePct: carScale,
        });
        ctx.drawImage(cutoutImg, rect.x, rect.y, rect.w, rect.h);
      }
      return;
    }

    if (adjustStraighten !== 0) {
      ctx.save();
      ctx.translate(targetSize.w / 2, targetSize.h / 2);
      ctx.rotate((adjustStraighten * Math.PI) / 180);
      ctx.translate(-targetSize.w / 2, -targetSize.h / 2);
      drawImageCover(ctx, originalImg, targetSize.w, targetSize.h);
      ctx.restore();
    } else {
      drawImageCover(ctx, originalImg, targetSize.w, targetSize.h);
    }
  }, [
    originalImg,
    cutoutImg,
    silhouetteAnalysis,
    groundEffectProfile,
    backdropImg,
    overlayImg,
    overlayPos,
    baseSize,
    shadowEnabled,
    shadowOpacity,
    shadowScale,
    shadowX,
    shadowY,
    reflectionEnabled,
    reflectionOpacity,
    reflectionScale,
    reflectionX,
    reflectionY,
    carX,
    carY,
    carScale,
    adjustStraighten,
  ]);

  // Crop drag interaction
  const cropDragRef = useRef<{ startX: number; startY: number; aspect: number | null } | null>(
    null,
  );

  const onCropPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTab !== "adjust") return;
    const wrap = previewWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    cropDragRef.current = { startX: x, startY: y, aspect: ASPECT_VALUE[adjustAspect] };
    setPendingCrop({ x, y, w: 0, h: 0 });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onCropPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = cropDragRef.current;
    if (!drag) return;
    const wrap = previewWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    let x = (e.clientX - rect.left) / rect.width;
    let y = (e.clientY - rect.top) / rect.height;
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
    const nx = Math.min(drag.startX, x);
    const ny = Math.min(drag.startY, y);
    let nw = Math.abs(x - drag.startX);
    let nh = Math.abs(y - drag.startY);
    if (drag.aspect !== null && nw > 0 && nh > 0) {
      // image-space aspect ratio: container is square-relative; convert via image size
      const imgAspect = originalImg ? originalImg.naturalWidth / originalImg.naturalHeight : 1;
      // normalized container coords: 1.0 wide × 1.0 tall, but image is imgAspect-shaped.
      // Constraint nw/nh (in image coords) = (nw * imgW) / (nh * imgH) = targetAspect
      // => nh = nw * imgAspect / targetAspect
      nh = (nw * imgAspect) / drag.aspect;
      if (ny + nh > 1) {
        nh = 1 - ny;
        nw = (nh * drag.aspect) / imgAspect;
      }
    }
    setPendingCrop({ x: nx, y: ny, w: nw, h: nh });
  };
  const onCropPointerUp = () => {
    cropDragRef.current = null;
  };

  const applyCrop = () => {
    if (!pendingCrop || pendingCrop.w < 0.02 || pendingCrop.h < 0.02) return;
    recordHistory();
    setAdjustCrop(pendingCrop);
    setPendingCrop(null);
  };
  const clearPending = () => setPendingCrop(null);

  const save = async () => {
    const canvas = canvasRef.current;
    if (!cutoutImg) return;
    setSaving(true);
    setError(null);
    try {
      let cutoutUrl = persistedCutoutUrl;
      if (pendingCutoutBlobRef.current) {
        await uploadPrivateVariant({
          photoId: photo.id,
          blob: pendingCutoutBlobRef.current,
          variantType: photo.cutout_image_url ? "corrected_cutout" : "cutout",
          processingProvider: "imgly-client",
        });
        cutoutUrl = URL.createObjectURL(pendingCutoutBlobRef.current);
      }

      if (!backdropImg || !baseSize) {
        if (!cutoutUrl) throw new Error("Create a cutout before saving.");
        onSaved();
        return;
      }

      if (!canvas) throw new Error("The customized preview is not ready yet.");

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("Failed to render"))),
          "image/jpeg",
          0.92,
        );
      });

      await uploadPrivateVariant({
        photoId: photo.id,
        blob,
        variantType: "customized",
        processingProvider: "dealershot-canvas",
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const ready = !!cutoutImg && !removing;
  const adjusting = activeTab === "adjust";

  const TABS: { key: TabKey; label: string }[] = [
    { key: "background", label: "Background" },
    { key: "adjust", label: "Adjust" },
    { key: "shadow", label: "Shadow" },
    { key: "reflection", label: "Reflection" },
    { key: "overlay", label: "Overlay" },
  ];

  const previewAspect = `${PREPARED_IMAGE_WIDTH} / ${PREPARED_IMAGE_HEIGHT}`;

  // Display rect of crop overlay (pending or committed) in container %
  const overlayCrop = pendingCrop ?? adjustCrop;

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="motion-overlay-static fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <DialogPrimitive.Content className="fixed inset-0 z-50 overflow-y-auto overscroll-contain focus:outline-none">
          <div className="min-h-full w-full flex items-stretch sm:items-start justify-center p-0 sm:p-4">
            <div className="motion-panel-static w-full sm:max-w-3xl sm:rounded-xl border-0 sm:border border-border bg-card p-4 sm:p-6 shadow-2xl sm:my-8">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <DialogPrimitive.Title className="text-lg font-semibold text-card-foreground">
                    Customize Photo
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="text-xs text-muted-foreground mt-0.5">
                    Prepare this photo while preserving its original source
                  </DialogPrimitive.Description>
                </div>
                <DialogPrimitive.Close asChild>
                  <button
                    className="grid size-11 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Close Customize"
                  >
                    <X className="size-5" />
                  </button>
                </DialogPrimitive.Close>
              </div>

              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/30 p-3">
                <Button
                  type="button"
                  onClick={() => void createCutout()}
                  disabled={removing || !originalImg}
                  aria-busy={removing}
                >
                  <Scissors className="size-4" />
                  {rawCutoutImg ? "Create New Cutout" : "Remove Background"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setMaskOpen(true)}
                  disabled={!rawCutoutImg || removing}
                >
                  Fix Cutout
                </Button>
                <span className="text-xs text-muted-foreground">
                  {rawCutoutImg
                    ? "Cutout ready for non-destructive correction."
                    : "Original photo preserved."}
                </span>
              </div>
              {removeErr && (
                <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {removeErr}
                </div>
              )}

              {backdrops.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    No backdrops are available. You can still create, correct, and save a
                    transparent cutout.
                  </p>
                  <div className="mt-5 flex justify-center gap-2">
                    <Button variant="outline" onClick={onClose}>
                      Cancel
                    </Button>
                    <Button onClick={() => void save()} disabled={saving || !ready}>
                      {saving ? "Saving…" : "Save Changes"}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-4">
                    <label className="block text-xs font-medium text-card-foreground mb-1.5">
                      Backdrop
                    </label>
                    <ProductSelect
                      value={backdropId}
                      onValueChange={track(setBackdropId)}
                      ariaLabel="Backdrop"
                      options={backdrops.map((backdrop) => ({
                        value: backdrop.id,
                        label: backdrop.name,
                      }))}
                    />
                  </div>

                  <div
                    ref={previewWrapRef}
                    className="relative w-full rounded-lg overflow-hidden bg-background border border-border select-none"
                    style={{ aspectRatio: previewAspect }}
                  >
                    {/* Persistent composition canvas — tab changes only swap controls. */}
                    <canvas
                      ref={canvasRef}
                      data-testid="customize-preview-canvas"
                      className="absolute inset-0 w-full h-full"
                    />

                    {/* Straighten grid overlay */}
                    {adjusting && adjustStraighten !== 0 && (
                      <div
                        aria-hidden
                        className="absolute inset-0 pointer-events-none"
                        style={{
                          backgroundImage:
                            "linear-gradient(to right, rgba(255,255,255,0.18) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.18) 1px, transparent 1px)",
                          backgroundSize: "10% 10%",
                        }}
                      />
                    )}

                    {/* Crop drag layer */}
                    {adjusting && (
                      <div
                        className="absolute inset-0 cursor-crosshair"
                        onPointerDown={onCropPointerDown}
                        onPointerMove={onCropPointerMove}
                        onPointerUp={onCropPointerUp}
                        onPointerCancel={onCropPointerUp}
                      >
                        {overlayCrop && (
                          <div
                            className="absolute border-2 border-primary"
                            style={{
                              left: `${overlayCrop.x * 100}%`,
                              top: `${overlayCrop.y * 100}%`,
                              width: `${overlayCrop.w * 100}%`,
                              height: `${overlayCrop.h * 100}%`,
                              boxShadow: "0 0 0 9999px rgba(0,0,0,0.4)",
                            }}
                          />
                        )}
                      </div>
                    )}

                    {ready && originalImg && comparePosition > 0 && (
                      <img
                        src={originalImg.src}
                        alt="Original photo before customization"
                        className="pointer-events-none absolute inset-0 z-10 h-full w-full object-cover"
                        style={{ clipPath: `inset(0 ${100 - comparePosition}% 0 0)` }}
                      />
                    )}

                    {ready && (
                      <>
                        {comparePosition > 0 && comparePosition < 100 && (
                          <div
                            aria-hidden
                            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white/90"
                            style={{ left: `${comparePosition}%` }}
                          />
                        )}
                        <div className="absolute inset-x-3 bottom-3 z-30 rounded-md bg-background/88 px-3 py-2 backdrop-blur-sm">
                          <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-foreground">
                            <span>Original</span>
                            <span>Edited</span>
                          </div>
                          <Slider
                            aria-label="Compare original and edited photo"
                            min={0}
                            max={100}
                            step={1}
                            value={[comparePosition]}
                            onValueChange={([value]) => setComparePosition(value ?? 0)}
                          />
                        </div>
                      </>
                    )}

                    {removing && (
                      <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-sm">
                        <div className="text-center">
                          <div className="h-8 w-8 mx-auto mb-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                          <p className="text-sm font-medium text-foreground">
                            {removeProgress === null
                              ? "Preparing background removal…"
                              : `Removing background… ${removeProgress}%`}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            First use downloads a ~12MB model. This happens entirely in your
                            browser.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Tab bar */}
                  <TabBar tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

                  {/* Tab content */}
                  <div key={activeTab} className="motion-content mt-4">
                    <div className="flex items-center justify-end gap-3 mb-2">
                      <button
                        type="button"
                        onClick={undo}
                        disabled={historyLen === 0}
                        className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-40 disabled:hover:no-underline disabled:cursor-not-allowed"
                      >
                        Undo{historyLen > 0 ? ` (${historyLen})` : ""}
                      </button>
                      <button
                        type="button"
                        onClick={resetCurrentTab}
                        className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      >
                        Reset to defaults
                      </button>
                    </div>

                    {activeTab === "background" && (
                      <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-4">
                        <p className="text-xs text-muted-foreground">
                          Choose a backdrop above. The preview updates instantly.
                        </p>
                        <div className="rounded-md border border-border/60 bg-background/30">
                          <button
                            type="button"
                            onClick={() => setCarPosOpen((v) => !v)}
                            className="w-full flex items-center justify-between px-3 py-2 min-h-[44px] text-left"
                          >
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Car Position
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {carPosOpen ? "−" : "+"}
                            </span>
                          </button>
                          {carPosOpen && (
                            <div className="motion-content px-3 pb-3 space-y-3">
                              <SliderRow
                                label="Position X"
                                value={carX}
                                min={-50}
                                max={50}
                                suffix="%"
                                onChange={track(setCarX)}
                              />
                              <SliderRow
                                label="Position Y"
                                value={carY}
                                min={-50}
                                max={50}
                                suffix="%"
                                onChange={track(setCarY)}
                              />
                              <SliderRow
                                label="Scale"
                                value={carScale}
                                min={50}
                                max={150}
                                suffix="%"
                                onChange={track(setCarScale)}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {activeTab === "adjust" && (
                      <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-4">
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Crop
                            </label>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={applyCrop}
                                disabled={!pendingCrop || pendingCrop.w < 0.02}
                                className="text-[11px] rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                              >
                                Apply Crop
                              </button>
                              <button
                                type="button"
                                onClick={clearPending}
                                disabled={!pendingCrop}
                                className="text-[11px] rounded-md border border-border bg-background px-2.5 py-1 text-foreground hover:bg-secondary disabled:opacity-50"
                              >
                                Clear
                              </button>
                            </div>
                          </div>
                          <p className="text-[11px] text-muted-foreground mb-2">
                            Drag on the preview to draw a selection.
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {(Object.keys(ASPECT_VALUE) as AspectKey[]).map((a) => (
                              <button
                                key={a}
                                type="button"
                                onClick={() => track(setAdjustAspect)(a)}
                                className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                                  adjustAspect === a
                                    ? "border-primary bg-primary/10 text-foreground"
                                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                                }`}
                              >
                                {a === "free" ? "Free" : a}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="rounded-md border border-border/60 bg-background/30 p-3">
                          <SliderRow
                            label="Straighten"
                            value={adjustStraighten}
                            min={-15}
                            max={15}
                            suffix="°"
                            onChange={track(setAdjustStraighten)}
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                            Fit / Expand
                          </label>
                          {[
                            { key: "none" as FitMode, label: "None" },
                            { key: "fit" as FitMode, label: "Fit (letterbox)" },
                            { key: "fill" as FitMode, label: "Fill (crop)" },
                            { key: "expand" as FitMode, label: "Expand canvas" },
                          ].map(({ key, label }) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => track(setAdjustFit)(key)}
                              className={`mr-1.5 mb-1.5 text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                                adjustFit === key
                                  ? "border-primary bg-primary/10 text-foreground"
                                  : "border-border bg-background text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                          <p className="text-[11px] text-muted-foreground mt-1.5">
                            Fit/Fill/Expand use the selected aspect ratio above.
                          </p>
                        </div>
                      </div>
                    )}

                    {activeTab === "shadow" && (
                      <div className="rounded-lg border border-border bg-secondary/30 p-4">
                        <div className="rounded-md border border-border/60 bg-background/30 p-3">
                          <label className="flex items-center justify-between cursor-pointer min-h-[44px] mb-1">
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Contact Shadow
                            </span>
                            <input
                              type="checkbox"
                              checked={shadowEnabled}
                              onChange={(e) =>
                                trackGroundEffect(setShadowEnabled)(e.target.checked)
                              }
                              className="h-4 w-4 accent-primary"
                            />
                          </label>
                          <p className="text-[11px] text-muted-foreground mb-3">
                            Angle-aware contact shadow fitted to the vehicle's lower silhouette.
                            Fine-tune it here when needed.
                          </p>
                          {shadowEnabled && (
                            <div className="space-y-3">
                              <SliderRow
                                label="Opacity"
                                value={shadowOpacity}
                                min={0}
                                max={100}
                                suffix="%"
                                onChange={trackGroundEffect(setShadowOpacity)}
                              />
                              <SliderRow
                                label="Size"
                                value={shadowScale}
                                min={40}
                                max={180}
                                suffix="%"
                                onChange={trackGroundEffect(setShadowScale)}
                              />
                              <SliderRow
                                label="Position X"
                                value={shadowX}
                                min={-200}
                                max={200}
                                suffix="px"
                                onChange={trackGroundEffect(setShadowX)}
                              />
                              <SliderRow
                                label="Position Y"
                                value={shadowY}
                                min={-100}
                                max={100}
                                suffix="px"
                                onChange={trackGroundEffect(setShadowY)}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {activeTab === "reflection" && (
                      <div className="rounded-lg border border-border bg-secondary/30 p-4">
                        <div className="rounded-md border border-border/60 bg-background/30 p-3">
                          <label className="flex items-center justify-between cursor-pointer min-h-[44px] mb-1">
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Floor Reflection
                            </span>
                            <input
                              type="checkbox"
                              checked={reflectionEnabled}
                              onChange={(e) =>
                                trackGroundEffect(setReflectionEnabled)(e.target.checked)
                              }
                              className="h-4 w-4 accent-primary"
                            />
                          </label>
                          <p className="text-[11px] text-muted-foreground mb-3">
                            Subtle floor reflection fitted to the vehicle angle and ground contact.
                            Fine-tune it here when needed.
                          </p>
                          {reflectionEnabled && (
                            <div className="space-y-3">
                              <SliderRow
                                label="Strength"
                                value={reflectionOpacity}
                                min={0}
                                max={100}
                                suffix="%"
                                onChange={trackGroundEffect(setReflectionOpacity)}
                              />
                              <SliderRow
                                label="Size"
                                value={reflectionScale}
                                min={50}
                                max={150}
                                suffix="%"
                                onChange={trackGroundEffect(setReflectionScale)}
                              />
                              <SliderRow
                                label="Position X"
                                value={reflectionX}
                                min={-200}
                                max={200}
                                suffix="px"
                                onChange={trackGroundEffect(setReflectionX)}
                              />
                              <SliderRow
                                label="Position Y"
                                value={reflectionY}
                                min={-100}
                                max={100}
                                suffix="px"
                                onChange={trackGroundEffect(setReflectionY)}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {activeTab === "overlay" && (
                      <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
                        <div>
                          <label className="block text-xs font-medium text-card-foreground mb-1.5">
                            Overlay
                          </label>
                          <ProductSelect
                            value={overlayId}
                            onValueChange={track(setOverlayId)}
                            ariaLabel="Overlay"
                            emptyLabel="None"
                            options={overlays.map((overlay) => ({
                              value: overlay.id,
                              label: `${overlay.name}${overlay.category ? ` — ${overlay.category}` : ""}`,
                            }))}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-card-foreground mb-1.5">
                            Overlay position
                          </label>
                          <ProductSelect
                            value={overlayPos}
                            onValueChange={(value) => track(setOverlayPos)(value as Position)}
                            disabled={!overlayId}
                            ariaLabel="Overlay position"
                            options={POSITIONS}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {error && (
                    <div className="mt-4 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
                      {error}
                    </div>
                  )}

                  <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <button
                      onClick={onClose}
                      className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void save()}
                      disabled={saving || !ready}
                      className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                    >
                      {saving ? "Saving…" : "Save Changes"}
                    </button>
                  </div>
                </>
              )}
              {rawCutoutImg && (
                <MaskEditor
                  open={maskOpen}
                  onOpenChange={setMaskOpen}
                  originalUrl={originalUrl}
                  cutoutUrl={rawCutoutImg.src}
                  onApply={applyCorrectedMask}
                />
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  suffix,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  hint?: string;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-medium text-card-foreground">{label}</label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {hint ?? `${value}${suffix ?? ""}`}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </div>
  );
}

function TabBar<T extends string>({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: { key: T; label: string }[];
  activeTab: T;
  onChange: (k: T) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(false);

  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowLeft(el.scrollLeft > 2);
    setShowRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    updateFades();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateFades);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateFades, tabs.length]);

  // Auto-scroll active tab into view (horizontal only — never scrolls page vertically)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const btn = el.querySelector<HTMLButtonElement>(`[data-tab-key="${activeTab}"]`);
    if (!btn) return;
    const elRect = el.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const delta =
      btnRect.left < elRect.left
        ? btnRect.left - elRect.left - 8
        : btnRect.right > elRect.right
          ? btnRect.right - elRect.right + 8
          : 0;
    if (delta !== 0) el.scrollBy({ left: delta, behavior: "smooth" });
  }, [activeTab]);

  return (
    <div className="relative mt-5">
      <div
        ref={scrollRef}
        onScroll={updateFades}
        className="border-b border-border flex gap-1 overflow-x-auto overflow-y-hidden scrollbar-none -mx-1 px-1"
        style={{ scrollbarWidth: "none", touchAction: "pan-x", overscrollBehavior: "contain" }}
      >
        {tabs.map((t) => {
          const active = activeTab === t.key;
          return (
            <button
              key={t.key}
              data-tab-key={t.key}
              type="button"
              onClick={() => onChange(t.key)}
              className={`motion-tab relative shrink-0 px-4 py-3 text-sm font-medium min-h-[44px] ${
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {active && (
                <span className="motion-content absolute left-2 right-2 -bottom-px h-0.5 bg-primary rounded-full" />
              )}
            </button>
          );
        })}
      </div>
      {showLeft && (
        <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-background to-transparent" />
      )}
      {showRight && (
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-background to-transparent" />
      )}
    </div>
  );
}
