import { useEffect, useRef, useState } from "react";
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

function buildShadowCanvas(
  cutout: HTMLImageElement,
  targetW: number,
  targetH: number,
  opacity: number,
  blur: number,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = targetW;
  c.height = targetH;
  const ctx = c.getContext("2d")!;
  const r = carRect(cutout, targetW, targetH);
  const shadowH = r.h * 0.18;
  // Draw squashed silhouette just below the car's bottom, with heavy blur
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(cutout, r.x, r.y + r.h - shadowH / 2, r.w, shadowH);
  ctx.filter = "none";
  // Tint silhouette to solid dark while preserving its alpha
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = `rgba(0,0,0,${opacity})`;
  ctx.fillRect(0, 0, targetW, targetH);
  return c;
}

function buildReflectionCanvas(
  cutout: HTMLImageElement,
  targetW: number,
  targetH: number,
  intensity: number,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = targetW;
  c.height = targetH;
  const ctx = c.getContext("2d")!;
  const r = carRect(cutout, targetW, targetH);
  // Flipped copy directly below the car
  ctx.save();
  ctx.translate(r.x, r.y + r.h * 2);
  ctx.scale(1, -1);
  ctx.drawImage(cutout, 0, 0, r.w, r.h);
  ctx.restore();
  // Fade from `intensity` at top of reflection down to 0 over half the car's height
  ctx.globalCompositeOperation = "destination-in";
  const grad = ctx.createLinearGradient(0, r.y + r.h, 0, r.y + r.h + r.h * 0.5);
  grad.addColorStop(0, `rgba(0,0,0,${intensity})`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, r.y + r.h, targetW, r.h);
  // Make sure nothing leaks above the ground line
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, targetW, r.y + r.h);
  return c;
}

function compose(
  ctx: CanvasRenderingContext2D,
  {
    cutout,
    backdrop,
    overlay,
    overlayPos,
    targetW,
    targetH,
    shadowOpacity,
    shadowBlur,
    reflectionIntensity,
  }: {
    cutout: HTMLImageElement;
    backdrop: HTMLImageElement;
    overlay: HTMLImageElement | null;
    overlayPos: Position;
    targetW: number;
    targetH: number;
    shadowOpacity: number;
    shadowBlur: number;
    reflectionIntensity: number;
  },
) {
  ctx.clearRect(0, 0, targetW, targetH);

  // 1. Backdrop (cover)
  const bScale = Math.max(targetW / backdrop.naturalWidth, targetH / backdrop.naturalHeight);
  const bw = backdrop.naturalWidth * bScale;
  const bh = backdrop.naturalHeight * bScale;
  ctx.drawImage(backdrop, (targetW - bw) / 2, (targetH - bh) / 2, bw, bh);

  // 2. Floor reflection
  if (reflectionIntensity > 0) {
    const ref = buildReflectionCanvas(cutout, targetW, targetH, reflectionIntensity);
    ctx.drawImage(ref, 0, 0);
  }

  // 3. Ground shadow
  if (shadowOpacity > 0) {
    const sh = buildShadowCanvas(cutout, targetW, targetH, shadowOpacity, shadowBlur);
    ctx.drawImage(sh, 0, 0);
  }

  // 4. Cut-out car
  const r = carRect(cutout, targetW, targetH);
  ctx.drawImage(cutout, r.x, r.y, r.w, r.h);

  // 5. Overlay banner
  if (overlay) {
    const o = destRect(targetW, targetH, overlay.naturalWidth, overlay.naturalHeight, overlayPos);
    ctx.drawImage(overlay, o.x, o.y, o.w, o.h);
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
  const [backdropId, setBackdropId] = useState<string>("");
  const [overlayId, setOverlayId] = useState<string>("");
  const [overlayPos, setOverlayPos] = useState<Position>("bottom");
  const [cutoutImg, setCutoutImg] = useState<HTMLImageElement | null>(null);
  const [backdropImg, setBackdropImg] = useState<HTMLImageElement | null>(null);
  const [overlayImg, setOverlayImg] = useState<HTMLImageElement | null>(null);
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [removing, setRemoving] = useState(true);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Compositing controls
  const [shadowIntensity, setShadowIntensity] = useState(60); // 0-100
  const [shadowSoftness, setShadowSoftness] = useState(25); // 0-50
  const [reflectionIntensity, setReflectionIntensity] = useState(35); // 0-100

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cutoutUrlRef = useRef<string | null>(null);

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
      if (bList.length > 0) setBackdropId(bList[0].id);
    })();
  }, [dealershipId]);

  // Background removal
  useEffect(() => {
    let cancelled = false;
    setRemoving(true);
    setRemoveErr(null);
    void (async () => {
      try {
        const base = await loadImage(photo.image_url);
        if (cancelled) return;
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

  // Load backdrop image
  useEffect(() => {
    const sel = backdrops.find((b) => b.id === backdropId);
    if (!sel) { setBackdropImg(null); return; }
    let cancelled = false;
    void loadImage(sel.image_url).then((img) => { if (!cancelled) setBackdropImg(img); });
    return () => { cancelled = true; };
  }, [backdropId, backdrops]);

  // Load overlay image
  useEffect(() => {
    const sel = overlays.find((o) => o.id === overlayId);
    if (!sel) { setOverlayImg(null); return; }
    let cancelled = false;
    void loadImage(sel.image_url).then((img) => { if (!cancelled) setOverlayImg(img); });
    return () => { cancelled = true; };
  }, [overlayId, overlays]);

  // Live preview render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cutoutImg || !backdropImg || !baseSize) return;
    canvas.width = baseSize.w;
    canvas.height = baseSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    compose(ctx, {
      cutout: cutoutImg,
      backdrop: backdropImg,
      overlay: overlayImg,
      overlayPos,
      targetW: baseSize.w,
      targetH: baseSize.h,
      shadowOpacity: shadowIntensity / 100,
      shadowBlur: shadowSoftness,
      reflectionIntensity: reflectionIntensity / 100,
    });
  }, [cutoutImg, backdropImg, overlayImg, overlayPos, baseSize, shadowIntensity, shadowSoftness, reflectionIntensity]);

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
            <div className="grid sm:grid-cols-3 gap-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-card-foreground mb-1.5">Backdrop</label>
                <select value={backdropId} onChange={(e) => setBackdropId(e.target.value)} className="form-input">
                  {backdrops.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-card-foreground mb-1.5">Overlay (optional)</label>
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

            <div
              className="relative w-full rounded-lg overflow-hidden bg-secondary border border-border"
              style={{ aspectRatio: baseSize ? `${baseSize.w} / ${baseSize.h}` : "16 / 9" }}
            >
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
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

            <div className="mt-5 rounded-lg border border-border bg-secondary/30 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-card-foreground mb-3">
                Compositing
              </h3>
              <div className="space-y-4">
                <SliderRow
                  label="Shadow Intensity"
                  value={shadowIntensity}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={setShadowIntensity}
                />
                <SliderRow
                  label="Shadow Softness"
                  value={shadowSoftness}
                  min={0}
                  max={50}
                  suffix="px"
                  onChange={setShadowSoftness}
                />
                <SliderRow
                  label="Reflection Intensity"
                  value={reflectionIntensity}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={setReflectionIntensity}
                  hint={reflectionIntensity === 0 ? "Disabled" : undefined}
                />
              </div>
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
