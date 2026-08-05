import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { removeBackground } from "@imgly/background-removal";
import { supabase } from "@/integrations/supabase/client";

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
  shadowOpacity: 55,
  shadowScale: 100,
  shadowX: 0,
  shadowY: 0,
  reflectionEnabled: true,
  reflectionOpacity: 30,
  reflectionScale: 100,
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
  targetW: number,
  targetH: number,
  opts: CarOpts = DEFAULT_CAR_OPTS,
) {
  const baseScale = Math.min(targetW / cutout.naturalWidth, targetH / cutout.naturalHeight);
  const scale = baseScale * (opts.scalePct / 100);
  const w = cutout.naturalWidth * scale;
  const h = cutout.naturalHeight * scale;
  const x = (targetW - w) / 2 + (opts.offsetXPct / 100) * targetW;
  const y = (targetH - h) / 2 + (opts.offsetYPct / 100) * targetH;
  return { x, y, w, h };
}

function findSilhouetteBounds(img: HTMLImageElement): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let top = height,
    bottom = 0,
    left = width,
    right = 0;
  const threshold = 32;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < top) {
    top = 0;
    bottom = height;
    left = 0;
    right = width;
  }
  return { top, bottom, left, right };
}

function buildOvalShadowCanvas(
  cutout: HTMLImageElement,
  bounds: { top: number; bottom: number; left: number; right: number },
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
  const r = carRect(cutout, targetW, targetH, carOpts);
  const sx = r.w / cutout.naturalWidth;
  const sy = r.h / cutout.naturalHeight;
  const carWidth = (bounds.right - bounds.left) * sx;
  const carBottomY = r.y + bounds.bottom * sy;
  const carCenterX = r.x + ((bounds.left + bounds.right) / 2) * sx;
  const s = scalePct / 100;
  const rx = Math.max(4, carWidth * 0.55 * s);
  const ry = Math.max(4, carWidth * 0.085 * s);
  const cx = carCenterX + offsetX;
  const cy = carBottomY + offsetY - ry * 0.1;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  grad.addColorStop(0, `rgba(0,0,0,${opacity})`);
  grad.addColorStop(0.55, `rgba(0,0,0,${opacity * 0.35})`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
  return c;
}

function buildReflectionCanvas(
  cutout: HTMLImageElement,
  bounds: { top: number; bottom: number; left: number; right: number },
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
  const r = carRect(cutout, targetW, targetH, carOpts);
  const sx = r.w / cutout.naturalWidth;
  const sy = r.h / cutout.naturalHeight;
  // Anchor at the silhouette's ground-contact point (bottom of cutout silhouette,
  // horizontally centered on the silhouette — not the image frame).
  const carBottomY = r.y + bounds.bottom * sy;
  const silCenterX = r.x + ((bounds.left + bounds.right) / 2) * sx;
  const silH = Math.max(1, (bounds.bottom - bounds.top) * sy);
  const groundY = carBottomY + offsetY;
  const s = Math.max(0.1, scalePct / 100);
  const centerX = silCenterX + offsetX;
  // Offset the cutout so its silhouette-bottom pixel lands at the local origin,
  // then the vertical flip mirrors the car downward from groundY.
  const dyAnchor = bounds.bottom * sy;
  ctx.save();
  ctx.translate(centerX, groundY);
  ctx.scale(s, -s);
  ctx.drawImage(cutout, -((bounds.left + bounds.right) / 2) * sx, -dyAnchor, r.w, r.h);
  ctx.restore();
  ctx.globalCompositeOperation = "destination-in";
  const fadeEnd = groundY + Math.max(20, silH * 0.65 * s);
  const grad = ctx.createLinearGradient(0, groundY, 0, fadeEnd);
  grad.addColorStop(0, `rgba(0,0,0,${intensity})`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, targetW, targetH);
  return c;
}

type ComposeOpts = {
  cutout: HTMLImageElement;
  bounds: { top: number; bottom: number; left: number; right: number };
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

  const bScale = Math.max(targetW / o.backdrop.naturalWidth, targetH / o.backdrop.naturalHeight);
  const bw = o.backdrop.naturalWidth * bScale;
  const bh = o.backdrop.naturalHeight * bScale;
  ctx.drawImage(o.backdrop, (targetW - bw) / 2, (targetH - bh) / 2, bw, bh);

  if (o.reflectionEnabled && o.reflectionOpacity > 0) {
    const ref = buildReflectionCanvas(
      o.cutout,
      o.bounds,
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
    const sh = buildOvalShadowCanvas(
      o.cutout,
      o.bounds,
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

  const r = carRect(o.cutout, targetW, targetH, o.carOpts);
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
  const [removing, setRemoving] = useState(true);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("background");

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
  const adjustPreviewRef = useRef<HTMLCanvasElement>(null);
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const cutoutUrlRef = useRef<string | null>(null);

  // Undo history
  const historyRef = useRef<Snapshot[]>([]);
  const suppressHistoryRef = useRef(false);
  const [historyLen, setHistoryLen] = useState(0);

  const bounds = useMemo(() => (cutoutImg ? findSilhouetteBounds(cutoutImg) : null), [cutoutImg]);

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

  const undo = () => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    setHistoryLen(historyRef.current.length);
    applySnapshot(prev);
  };

  const resetCompositing = () => {
    recordHistory();
    setShadowEnabled(DEFAULTS.shadowEnabled);
    setShadowOpacity(DEFAULTS.shadowOpacity);
    setShadowScale(DEFAULTS.shadowScale);
    setShadowX(DEFAULTS.shadowX);
    setShadowY(DEFAULTS.shadowY);
    setReflectionEnabled(DEFAULTS.reflectionEnabled);
    setReflectionOpacity(DEFAULTS.reflectionOpacity);
    setReflectionScale(DEFAULTS.reflectionScale);
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
    setShadowEnabled(DEFAULTS.shadowEnabled);
    setShadowOpacity(DEFAULTS.shadowOpacity);
    setShadowScale(DEFAULTS.shadowScale);
    setShadowX(DEFAULTS.shadowX);
    setShadowY(DEFAULTS.shadowY);
  };
  const resetReflection = () => {
    recordHistory();
    setReflectionEnabled(DEFAULTS.reflectionEnabled);
    setReflectionOpacity(DEFAULTS.reflectionOpacity);
    setReflectionScale(DEFAULTS.reflectionScale);
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

  // Load the actual original once (for compare)
  useEffect(() => {
    void loadImage(photo.image_url).then(setOriginalImg);
  }, [photo.image_url]);

  // Lock background page scroll while the editor is open so scrolling stays in the modal.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Run background removal ONCE per photo. Adjust transforms (crop/straighten/fit)
  // operate on the cached cutout PNG below — they never re-invoke the model.
  useEffect(() => {
    let cancelled = false;
    setRemoving(true);
    setRemoveErr(null);
    void (async () => {
      try {
        const base = await loadImage(photo.image_url);
        if (cancelled) return;
        if (photo.is_cutout) {
          setRawCutoutImg(base);
          return;
        }
        const blob = await removeBackground(photo.image_url, {
          model: "isnet_quint8",
          debug: true,
        });
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (cutoutUrlRef.current) URL.revokeObjectURL(cutoutUrlRef.current);
        cutoutUrlRef.current = url;
        const img = await loadImage(url);
        if (cancelled) return;
        setRawCutoutImg(img);
      } catch (err) {
        if (!cancelled)
          setRemoveErr(err instanceof Error ? err.message : "Background removal failed");
      } finally {
        if (!cancelled) setRemoving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [photo.image_url, photo.is_cutout]);

  useEffect(() => {
    return () => {
      if (cutoutUrlRef.current) URL.revokeObjectURL(cutoutUrlRef.current);
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
            // eslint-disable-next-line no-console
            console.warn("[bg-editor] adjust bake failed", err);
          });
      } catch (err) {
        // eslint-disable-next-line no-console
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

  // Composite canvas render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cutoutImg || !backdropImg || !baseSize || !bounds) return;
    canvas.width = baseSize.w;
    canvas.height = baseSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    compose(ctx, {
      cutout: cutoutImg,
      bounds,
      backdrop: backdropImg,
      overlay: overlayImg,
      overlayPos,
      targetW: baseSize.w,
      targetH: baseSize.h,
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
  }, [
    cutoutImg,
    bounds,
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
  ]);

  // Adjust-tab live preview render
  useEffect(() => {
    if (activeTab !== "adjust") return;
    const cv = adjustPreviewRef.current;
    if (!cv || !originalImg) return;
    const ow = originalImg.naturalWidth;
    const oh = originalImg.naturalHeight;
    cv.width = ow;
    cv.height = oh;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, ow, oh);
    if (adjustStraighten !== 0) {
      ctx.save();
      ctx.translate(ow / 2, oh / 2);
      ctx.rotate((adjustStraighten * Math.PI) / 180);
      ctx.drawImage(originalImg, -ow / 2, -oh / 2);
      ctx.restore();
    } else {
      ctx.drawImage(originalImg, 0, 0);
    }
    // Show committed crop as a dimmed mask outside the crop rect
    if (adjustCrop) {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      const cx = adjustCrop.x * ow;
      const cy = adjustCrop.y * oh;
      const cw = adjustCrop.w * ow;
      const ch = adjustCrop.h * oh;
      ctx.fillRect(0, 0, ow, cy);
      ctx.fillRect(0, cy + ch, ow, oh - (cy + ch));
      ctx.fillRect(0, cy, cx, ch);
      ctx.fillRect(cx + cw, cy, ow - (cx + cw), ch);
      ctx.restore();
    }
  }, [activeTab, originalImg, adjustStraighten, adjustCrop]);

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

  const save = async (mode: "new" | "overwrite") => {
    const canvas = canvasRef.current;
    if (!canvas || !cutoutImg || !backdropImg || !baseSize) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Failed to render"))),
          "image/jpeg",
          0.92,
        );
      });
      const path = `${photo.vehicle_id}/${crypto.randomUUID()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from("vehicle-photos")
        .upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("vehicle-photos").getPublicUrl(path);

      if (mode === "new") {
        const { error: insErr } = await supabase.from("photos").insert({
          vehicle_id: photo.vehicle_id,
          image_url: pub.publicUrl,
          shot_type: photo.shot_type,
          sort_order: (photo.sort_order ?? 0) + 1,
        });
        if (insErr) throw insErr;
      } else {
        try {
          const url = new URL(photo.image_url);
          const idx = url.pathname.indexOf("/vehicle-photos/");
          if (idx !== -1) {
            const oldPath = url.pathname.slice(idx + "/vehicle-photos/".length);
            await supabase.storage.from("vehicle-photos").remove([oldPath]);
          }
        } catch {
          /* ignore */
        }
        const { error: updErr } = await supabase
          .from("photos")
          .update({ image_url: pub.publicUrl })
          .eq("id", photo.id);
        if (updErr) throw updErr;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const ready = !!cutoutImg && !!backdropImg && !!baseSize && !removing;
  const adjusting = activeTab === "adjust";

  const TABS: { key: TabKey; label: string }[] = [
    { key: "background", label: "Background" },
    { key: "adjust", label: "Adjust" },
    { key: "shadow", label: "Shadow" },
    { key: "reflection", label: "Reflection" },
    { key: "overlay", label: "Overlay" },
  ];

  const previewAspect = baseSize
    ? `${baseSize.w} / ${baseSize.h}`
    : originalImg
      ? `${originalImg.naturalWidth} / ${originalImg.naturalHeight}`
      : "16 / 9";

  // Display rect of crop overlay (pending or committed) in container %
  const overlayCrop = pendingCrop ?? adjustCrop;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-background/80 backdrop-blur-sm">
      <div className="min-h-full w-full flex items-stretch sm:items-start justify-center p-0 sm:p-4">
        <div className="w-full sm:max-w-3xl sm:rounded-xl border-0 sm:border border-border bg-card p-4 sm:p-6 shadow-2xl sm:my-8">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-card-foreground">Change Background</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Remove the original background and composite onto a backdrop
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>

          {backdrops.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-8 text-sm text-muted-foreground text-center">
              No backdrops available for this dealership. Create one on the Backdrops page first.
            </div>
          ) : (
            <>
              <div className="mb-4">
                <label className="block text-xs font-medium text-card-foreground mb-1.5">
                  Backdrop
                </label>
                <select
                  value={backdropId}
                  onChange={(e) => track(setBackdropId)(e.target.value)}
                  className="form-input"
                >
                  {backdrops.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>

              <div
                ref={previewWrapRef}
                className="relative w-full rounded-lg overflow-hidden bg-background border border-border select-none"
                style={{ aspectRatio: previewAspect }}
              >
                {/* Composite canvas — visible on every tab except Adjust */}
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 w-full h-full"
                  style={{ visibility: comparing || adjusting ? "hidden" : "visible" }}
                />

                {/* Adjust live preview canvas */}
                <canvas
                  ref={adjustPreviewRef}
                  className="absolute inset-0 w-full h-full object-contain"
                  style={{ display: adjusting && !comparing ? "block" : "none" }}
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

                {comparing && originalImg && (
                  <img
                    src={originalImg.src}
                    alt="Original"
                    className="absolute inset-0 w-full h-full object-contain"
                  />
                )}

                {ready && (
                  <button
                    type="button"
                    onMouseDown={() => setComparing(true)}
                    onMouseUp={() => setComparing(false)}
                    onMouseLeave={() => setComparing(false)}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      setComparing(true);
                    }}
                    onTouchEnd={() => setComparing(false)}
                    onTouchCancel={() => setComparing(false)}
                    className="absolute top-2 right-2 select-none rounded-md bg-background/80 backdrop-blur px-2.5 py-1.5 text-[11px] font-medium text-foreground border border-border hover:bg-background"
                    title="Hold to view original"
                  >
                    {comparing ? "Showing original" : "Hold to compare"}
                  </button>
                )}

                {removing && (
                  <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-sm">
                    <div className="text-center">
                      <div className="h-8 w-8 mx-auto mb-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                      <p className="text-sm font-medium text-foreground">Cutting out the car…</p>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        First use downloads a ~12MB model. This happens entirely in your browser.
                      </p>
                    </div>
                  </div>
                )}
                {removeErr && (
                  <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-6">
                    <p className="text-sm text-destructive text-center">{removeErr}</p>
                  </div>
                )}
              </div>

              {/* Tab bar */}
              <TabBar tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

              {/* Tab content */}
              <div className="mt-4">
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
                        <div className="px-3 pb-3 space-y-3">
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
                          onChange={(e) => track(setShadowEnabled)(e.target.checked)}
                          className="h-4 w-4 accent-primary"
                        />
                      </label>
                      <p className="text-[11px] text-muted-foreground mb-3">
                        Soft oval contact shadow auto-placed under the car. Turn off for interiors
                        or detail shots.
                      </p>
                      {shadowEnabled && (
                        <div className="space-y-3">
                          <SliderRow
                            label="Opacity"
                            value={shadowOpacity}
                            min={0}
                            max={100}
                            suffix="%"
                            onChange={track(setShadowOpacity)}
                          />
                          <SliderRow
                            label="Size"
                            value={shadowScale}
                            min={40}
                            max={180}
                            suffix="%"
                            onChange={track(setShadowScale)}
                          />
                          <SliderRow
                            label="Position X"
                            value={shadowX}
                            min={-200}
                            max={200}
                            suffix="px"
                            onChange={track(setShadowX)}
                          />
                          <SliderRow
                            label="Position Y"
                            value={shadowY}
                            min={-100}
                            max={100}
                            suffix="px"
                            onChange={track(setShadowY)}
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
                          onChange={(e) => track(setReflectionEnabled)(e.target.checked)}
                          className="h-4 w-4 accent-primary"
                        />
                      </label>
                      <p className="text-[11px] text-muted-foreground mb-3">
                        Mirror reflection under the car. Nudge to align if you move or resize it.
                      </p>
                      {reflectionEnabled && (
                        <div className="space-y-3">
                          <SliderRow
                            label="Strength"
                            value={reflectionOpacity}
                            min={0}
                            max={100}
                            suffix="%"
                            onChange={track(setReflectionOpacity)}
                          />
                          <SliderRow
                            label="Size"
                            value={reflectionScale}
                            min={50}
                            max={150}
                            suffix="%"
                            onChange={track(setReflectionScale)}
                          />
                          <SliderRow
                            label="Position X"
                            value={reflectionX}
                            min={-200}
                            max={200}
                            suffix="px"
                            onChange={track(setReflectionX)}
                          />
                          <SliderRow
                            label="Position Y"
                            value={reflectionY}
                            min={-100}
                            max={100}
                            suffix="px"
                            onChange={track(setReflectionY)}
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
                      <select
                        value={overlayId}
                        onChange={(e) => track(setOverlayId)(e.target.value)}
                        className="form-input"
                      >
                        <option value="">None</option>
                        {overlays.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                            {o.category ? ` — ${o.category}` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-card-foreground mb-1.5">
                        Overlay position
                      </label>
                      <select
                        value={overlayPos}
                        onChange={(e) => track(setOverlayPos)(e.target.value as Position)}
                        disabled={!overlayId}
                        className="form-input disabled:opacity-50"
                      >
                        {POSITIONS.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
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
                  onClick={() => void save("new")}
                  disabled={saving || !ready}
                  className="rounded-md border border-border bg-secondary px-4 py-2 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save as new photo"}
                </button>
                <button
                  onClick={() => {
                    if (confirm("Overwrite the original photo? This cannot be undone."))
                      void save("overwrite");
                  }}
                  disabled={saving || !ready}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Overwrite original"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
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
              className={`relative shrink-0 px-4 py-3 text-sm font-medium transition-colors min-h-[44px] ${
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {active && (
                <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-primary rounded-full" />
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
