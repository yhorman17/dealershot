import { useEffect, useMemo, useRef, useState } from "react";
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
};

type TabKey = "background" | "compositing" | "overlay";

// Defaults
const DEFAULTS = {
  shadowIntensity: 60,
  shadowSoftness: 25,
  shadowX: 0,
  shadowY: 0,
  shadowAngle: 0,
  shadowScale: 100,
  reflectionIntensity: 35,
  reflectionX: 0,
  reflectionY: 0,
  tireContacts: false,
  tireIntensity: 50,
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

function carRect(cutout: HTMLImageElement, targetW: number, targetH: number) {
  const scale = Math.min(targetW / cutout.naturalWidth, targetH / cutout.naturalHeight);
  const w = cutout.naturalWidth * scale;
  const h = cutout.naturalHeight * scale;
  return { x: (targetW - w) / 2, y: (targetH - h) / 2, w, h };
}

// Find the true bottom edge of the silhouette in cutout image space
function findSilhouetteBounds(img: HTMLImageElement): { top: number; bottom: number; left: number; right: number } {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let top = height, bottom = 0, left = width, right = 0;
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
  if (bottom < top) { top = 0; bottom = height; left = 0; right = width; }
  return { top, bottom, left, right };
}

function buildShadowCanvas(
  cutout: HTMLImageElement,
  bounds: { top: number; bottom: number; left: number; right: number },
  targetW: number,
  targetH: number,
  opacity: number,
  blur: number,
  offsetX: number,
  offsetY: number,
  angleDeg: number,
  scalePct: number,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = targetW;
  c.height = targetH;
  const ctx = c.getContext("2d")!;
  const r = carRect(cutout, targetW, targetH);
  // Convert silhouette bounds from cutout-space to target-space
  const sx = r.w / cutout.naturalWidth;
  const sy = r.h / cutout.naturalHeight;
  const carWidth = (bounds.right - bounds.left) * sx;
  const carBottomY = r.y + bounds.bottom * sy;
  const carCenterX = r.x + ((bounds.left + bounds.right) / 2) * sx;

  const s = scalePct / 100;
  // Shadow size based on actual car silhouette, not full cutout bbox
  const baseShadowH = carWidth * 0.22; // proportional to car width for a believable ellipse
  const shadowW = carWidth * 1.1 * s;
  const shadowH = baseShadowH * s;
  const cx = carCenterX + offsetX;
  const cy = carBottomY + offsetY;

  ctx.filter = `blur(${blur}px)`;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((angleDeg * Math.PI) / 180);
  // Draw vertically-squashed silhouette so the shadow has car-like shape
  const scaleSilY = shadowH / r.h;
  const scaleSilX = shadowW / r.w;
  ctx.scale(scaleSilX, scaleSilY);
  ctx.drawImage(cutout, -r.x - r.w / 2, -r.y - r.h / 2, r.w, r.h);
  ctx.restore();
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = `rgba(0,0,0,${opacity})`;
  ctx.fillRect(0, 0, targetW, targetH);
  return c;
}

function buildTireContactCanvas(
  cutout: HTMLImageElement,
  bounds: { top: number; bottom: number; left: number; right: number },
  targetW: number,
  targetH: number,
  opacity: number,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = targetW;
  c.height = targetH;
  const ctx = c.getContext("2d")!;
  const r = carRect(cutout, targetW, targetH);
  const sx = r.w / cutout.naturalWidth;
  const sy = r.h / cutout.naturalHeight;
  const carWidth = (bounds.right - bounds.left) * sx;
  const carBottomY = r.y + bounds.bottom * sy;
  const carCenterX = r.x + ((bounds.left + bounds.right) / 2) * sx;
  const bandW = carWidth * 0.95;
  const bandH = carWidth * 0.04;
  ctx.filter = `blur(${Math.max(3, carWidth * 0.008)}px)`;
  ctx.beginPath();
  ctx.ellipse(carCenterX, carBottomY, bandW / 2, bandH, 0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(0,0,0,${opacity})`;
  ctx.fill();
  ctx.filter = "none";
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
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = targetW;
  c.height = targetH;
  const ctx = c.getContext("2d")!;
  const r = carRect(cutout, targetW, targetH);
  const sy = r.h / cutout.naturalHeight;
  const carBottomY = r.y + bounds.bottom * sy;
  const groundY = carBottomY + offsetY;
  ctx.save();
  ctx.translate(r.x + offsetX, groundY + r.h);
  ctx.scale(1, -1);
  ctx.drawImage(cutout, 0, 0, r.w, r.h);
  ctx.restore();
  ctx.globalCompositeOperation = "destination-in";
  const grad = ctx.createLinearGradient(0, groundY, 0, groundY + r.h * 0.5);
  grad.addColorStop(0, `rgba(0,0,0,${intensity})`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, groundY, targetW, r.h);
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, targetW, groundY);
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
  shadowOpacity: number;
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  shadowAngle: number;
  shadowScale: number;
  reflectionIntensity: number;
  reflectionX: number;
  reflectionY: number;
  tireContacts: boolean;
  tireIntensity: number;
};

function compose(ctx: CanvasRenderingContext2D, o: ComposeOpts) {
  const { targetW, targetH } = o;
  ctx.clearRect(0, 0, targetW, targetH);

  const bScale = Math.max(targetW / o.backdrop.naturalWidth, targetH / o.backdrop.naturalHeight);
  const bw = o.backdrop.naturalWidth * bScale;
  const bh = o.backdrop.naturalHeight * bScale;
  ctx.drawImage(o.backdrop, (targetW - bw) / 2, (targetH - bh) / 2, bw, bh);

  if (o.reflectionIntensity > 0) {
    const ref = buildReflectionCanvas(o.cutout, o.bounds, targetW, targetH, o.reflectionIntensity, o.reflectionX, o.reflectionY);
    ctx.drawImage(ref, 0, 0);
  }

  if (o.shadowOpacity > 0) {
    const sh = buildShadowCanvas(
      o.cutout, o.bounds, targetW, targetH,
      o.shadowOpacity, o.shadowBlur,
      o.shadowX, o.shadowY, o.shadowAngle, o.shadowScale,
    );
    ctx.drawImage(sh, 0, 0);
  }

  if (o.tireContacts && o.tireIntensity > 0) {
    const tc = buildTireContactCanvas(o.cutout, o.bounds, targetW, targetH, o.tireIntensity);
    ctx.drawImage(tc, 0, 0);
  }

  const r = carRect(o.cutout, targetW, targetH);
  ctx.drawImage(o.cutout, r.x, r.y, r.w, r.h);

  if (o.overlay) {
    const dr = destRect(targetW, targetH, o.overlay.naturalWidth, o.overlay.naturalHeight, o.overlayPos);
    ctx.drawImage(o.overlay, dr.x, dr.y, dr.w, dr.h);
  }
}

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

  const [shadowIntensity, setShadowIntensity] = useState(DEFAULTS.shadowIntensity);
  const [shadowSoftness, setShadowSoftness] = useState(DEFAULTS.shadowSoftness);
  const [shadowX, setShadowX] = useState(DEFAULTS.shadowX);
  const [shadowY, setShadowY] = useState(DEFAULTS.shadowY);
  const [shadowAngle, setShadowAngle] = useState(DEFAULTS.shadowAngle);
  const [shadowScale, setShadowScale] = useState(DEFAULTS.shadowScale);
  const [reflectionIntensity, setReflectionIntensity] = useState(DEFAULTS.reflectionIntensity);
  const [reflectionX, setReflectionX] = useState(DEFAULTS.reflectionX);
  const [reflectionY, setReflectionY] = useState(DEFAULTS.reflectionY);
  const [tireContacts, setTireContacts] = useState(DEFAULTS.tireContacts);
  const [tireIntensity, setTireIntensity] = useState(DEFAULTS.tireIntensity);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cutoutUrlRef = useRef<string | null>(null);

  // Compute silhouette bounds once per cutout
  const bounds = useMemo(() => (cutoutImg ? findSilhouetteBounds(cutoutImg) : null), [cutoutImg]);

  const resetCompositing = () => {
    setShadowIntensity(DEFAULTS.shadowIntensity);
    setShadowSoftness(DEFAULTS.shadowSoftness);
    setShadowX(DEFAULTS.shadowX);
    setShadowY(DEFAULTS.shadowY);
    setShadowAngle(DEFAULTS.shadowAngle);
    setShadowScale(DEFAULTS.shadowScale);
    setReflectionIntensity(DEFAULTS.reflectionIntensity);
    setReflectionX(DEFAULTS.reflectionX);
    setReflectionY(DEFAULTS.reflectionY);
    setTireContacts(DEFAULTS.tireContacts);
    setTireIntensity(DEFAULTS.tireIntensity);
  };

  const resetCurrentTab = () => {
    if (activeTab === "background") setBackdropId(defaultBackdropId);
    else if (activeTab === "compositing") resetCompositing();
    else if (activeTab === "overlay") { setOverlayId(""); setOverlayPos("bottom"); }
  };

  useEffect(() => {
    void (async () => {
      const [{ data: bs }, { data: os }] = await Promise.all([
        supabase.from("backdrops").select("id, name, image_url").eq("dealership_id", dealershipId).order("created_at", { ascending: false }),
        supabase.from("overlay_templates").select("id, name, image_url, category").eq("dealership_id", dealershipId).order("created_at", { ascending: false }),
      ]);
      const bList = (bs as Backdrop[]) || [];
      const oList = (os as OverlayTemplate[]) || [];
      setBackdrops(bList);
      setOverlays(oList);
      if (bList.length > 0) {
        setBackdropId(bList[0].id);
        setDefaultBackdropId(bList[0].id);
      }
    })();
  }, [dealershipId]);

  useEffect(() => {
    let cancelled = false;
    setRemoving(true);
    setRemoveErr(null);
    void (async () => {
      try {
        const base = await loadImage(photo.image_url);
        if (cancelled) return;
        setOriginalImg(base);
        setBaseSize({ w: base.naturalWidth, h: base.naturalHeight });
        const blob = await removeBackground(photo.image_url);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        cutoutUrlRef.current = url;
        const img = await loadImage(url);
        if (cancelled) return;
        setCutoutImg(img);
      } catch (err) {
        if (!cancelled) setRemoveErr(err instanceof Error ? err.message : "Background removal failed");
      } finally {
        if (!cancelled) setRemoving(false);
      }
    })();
    return () => {
      cancelled = true;
      if (cutoutUrlRef.current) URL.revokeObjectURL(cutoutUrlRef.current);
    };
  }, [photo.image_url]);

  useEffect(() => {
    const sel = backdrops.find((b) => b.id === backdropId);
    if (!sel) { setBackdropImg(null); return; }
    let cancelled = false;
    void loadImage(sel.image_url).then((img) => { if (!cancelled) setBackdropImg(img); });
    return () => { cancelled = true; };
  }, [backdropId, backdrops]);

  useEffect(() => {
    const sel = overlays.find((o) => o.id === overlayId);
    if (!sel) { setOverlayImg(null); return; }
    let cancelled = false;
    void loadImage(sel.image_url).then((img) => { if (!cancelled) setOverlayImg(img); });
    return () => { cancelled = true; };
  }, [overlayId, overlays]);

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
      shadowOpacity: shadowIntensity / 100,
      shadowBlur: shadowSoftness,
      shadowX,
      shadowY,
      shadowAngle,
      shadowScale,
      reflectionIntensity: reflectionIntensity / 100,
      reflectionX,
      reflectionY,
      tireContacts,
      tireIntensity: tireIntensity / 100,
    });
  }, [
    cutoutImg, bounds, backdropImg, overlayImg, overlayPos, baseSize,
    shadowIntensity, shadowSoftness, shadowX, shadowY, shadowAngle, shadowScale,
    reflectionIntensity, reflectionX, reflectionY,
    tireContacts, tireIntensity,
  ]);

  const save = async (mode: "new" | "overwrite") => {
    const canvas = canvasRef.current;
    if (!canvas || !cutoutImg || !backdropImg || !baseSize) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to render"))), "image/jpeg", 0.92);
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
        } catch { /* ignore */ }
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

  const TABS: { key: TabKey; label: string }[] = [
    { key: "background", label: "Background" },
    { key: "compositing", label: "Compositing" },
    { key: "overlay", label: "Overlay" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 overflow-auto">
      <div className="w-full max-w-3xl rounded-xl border border-border bg-card p-6 shadow-2xl my-8">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-card-foreground">Change Background</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Remove the original background and composite onto a backdrop
            </p>
          </div>
          <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">✕</button>
        </div>

        {backdrops.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-8 text-sm text-muted-foreground text-center">
            No backdrops available for this dealership. Create one on the Backdrops page first.
          </div>
        ) : (
          <>
            {/* Always-visible workspace: backdrop dropdown + preview */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-card-foreground mb-1.5">Backdrop</label>
              <select value={backdropId} onChange={(e) => setBackdropId(e.target.value)} className="form-input">
                {backdrops.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>

            <div
              className="relative w-full rounded-lg overflow-hidden bg-secondary border border-border"
              style={{ aspectRatio: baseSize ? `${baseSize.w} / ${baseSize.h}` : "16 / 9" }}
            >
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
                style={{ visibility: comparing ? "hidden" : "visible" }}
              />
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
                  onTouchStart={(e) => { e.preventDefault(); setComparing(true); }}
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
                      First use downloads a ~40MB model. This happens entirely in your browser.
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
            <div className="mt-5 border-b border-border flex gap-1">
              {TABS.map((t) => {
                const active = activeTab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setActiveTab(t.key)}
                    className={`relative px-4 py-3 text-sm font-medium transition-colors min-h-[44px] ${
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

            {/* Tab content */}
            <div className="mt-4">
              <div className="flex items-center justify-end mb-2">
                <button
                  type="button"
                  onClick={resetCurrentTab}
                  className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                >
                  Reset to defaults
                </button>
              </div>

              {activeTab === "background" && (
                <div className="rounded-lg border border-border bg-secondary/30 p-4 text-xs text-muted-foreground">
                  Choose a backdrop above. The preview updates instantly. Use the Compositing tab to refine
                  shadows and reflections, and the Overlay tab to add a banner.
                </div>
              )}

              {activeTab === "compositing" && (
                <div className="rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="rounded-md border border-border/60 bg-background/30 p-3 mb-3">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Shadow</h4>
                    <div className="space-y-3">
                      <SliderRow label="Intensity" value={shadowIntensity} min={0} max={100} suffix="%" onChange={setShadowIntensity} />
                      <SliderRow label="Softness" value={shadowSoftness} min={0} max={50} suffix="px" onChange={setShadowSoftness} />
                      <SliderRow label="Position X" value={shadowX} min={-200} max={200} suffix="px" onChange={setShadowX} />
                      <SliderRow label="Position Y" value={shadowY} min={-100} max={100} suffix="px" onChange={setShadowY} />
                      <SliderRow label="Angle" value={shadowAngle} min={-45} max={45} suffix="°" onChange={setShadowAngle} />
                      <SliderRow label="Scale" value={shadowScale} min={50} max={150} suffix="%" onChange={setShadowScale} />

                      <label className="flex items-center gap-2 pt-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={tireContacts}
                          onChange={(e) => setTireContacts(e.target.checked)}
                          className="h-4 w-4 accent-primary"
                        />
                        <span className="text-xs font-medium text-card-foreground">Add tire contact shadows</span>
                      </label>
                      {tireContacts && (
                        <SliderRow
                          label="Tire Contact Intensity"
                          value={tireIntensity}
                          min={0}
                          max={100}
                          suffix="%"
                          onChange={setTireIntensity}
                        />
                      )}
                    </div>
                  </div>

                  <div className="rounded-md border border-border/60 bg-background/30 p-3">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Reflection</h4>
                    <div className="space-y-3">
                      <SliderRow
                        label="Intensity"
                        value={reflectionIntensity}
                        min={0}
                        max={100}
                        suffix="%"
                        onChange={setReflectionIntensity}
                        hint={reflectionIntensity === 0 ? "Disabled" : undefined}
                      />
                      <SliderRow label="Position X" value={reflectionX} min={-200} max={200} suffix="px" onChange={setReflectionX} />
                      <SliderRow label="Position Y" value={reflectionY} min={-50} max={100} suffix="px" onChange={setReflectionY} />
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "overlay" && (
                <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-card-foreground mb-1.5">Overlay</label>
                    <select value={overlayId} onChange={(e) => setOverlayId(e.target.value)} className="form-input">
                      <option value="">None</option>
                      {overlays.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}{o.category ? ` — ${o.category}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-card-foreground mb-1.5">Overlay position</label>
                    <select
                      value={overlayPos}
                      onChange={(e) => setOverlayPos(e.target.value as Position)}
                      disabled={!overlayId}
                      className="form-input disabled:opacity-50"
                    >
                      {POSITIONS.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
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
                  if (confirm("Overwrite the original photo? This cannot be undone.")) void save("overwrite");
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
