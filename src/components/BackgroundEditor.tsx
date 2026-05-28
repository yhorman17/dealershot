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

async function compose({
  cutoutUrl,
  backdropUrl,
  overlayUrl,
  overlayPos,
  targetW,
  targetH,
}: {
  cutoutUrl: string;
  backdropUrl: string;
  overlayUrl: string | null;
  overlayPos: Position;
  targetW: number;
  targetH: number;
}): Promise<Blob> {
  const [cutout, backdrop, overlay] = await Promise.all([
    loadImage(cutoutUrl),
    loadImage(backdropUrl),
    overlayUrl ? loadImage(overlayUrl) : Promise.resolve(null),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  // Backdrop: cover
  const bScale = Math.max(targetW / backdrop.naturalWidth, targetH / backdrop.naturalHeight);
  const bw = backdrop.naturalWidth * bScale;
  const bh = backdrop.naturalHeight * bScale;
  ctx.drawImage(backdrop, (targetW - bw) / 2, (targetH - bh) / 2, bw, bh);

  // Cutout: contain
  const cScale = Math.min(targetW / cutout.naturalWidth, targetH / cutout.naturalHeight);
  const cw = cutout.naturalWidth * cScale;
  const ch = cutout.naturalHeight * cScale;
  ctx.drawImage(cutout, (targetW - cw) / 2, (targetH - ch) / 2, cw, ch);

  if (overlay) {
    const r = destRect(targetW, targetH, overlay.naturalWidth, overlay.naturalHeight, overlayPos);
    ctx.drawImage(overlay, r.x, r.y, r.w, r.h);
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to render"))), "image/jpeg", 0.92);
  });
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
  const [cutoutUrl, setCutoutUrl] = useState<string | null>(null);
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [removing, setRemoving] = useState(true);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cutoutRevokeRef = useRef<string | null>(null);

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
        cutoutRevokeRef.current = url;
        setCutoutUrl(url);
      } catch (err) {
        if (!cancelled) setRemoveErr(err instanceof Error ? err.message : "Background removal failed");
      } finally {
        if (!cancelled) setRemoving(false);
      }
    })();
    return () => {
      cancelled = true;
      if (cutoutRevokeRef.current) URL.revokeObjectURL(cutoutRevokeRef.current);
    };
  }, [photo.image_url]);

  const selectedBackdrop = backdrops.find((b) => b.id === backdropId);
  const selectedOverlay = overlays.find((o) => o.id === overlayId);

  const save = async (mode: "new" | "overwrite") => {
    if (!cutoutUrl || !selectedBackdrop || !baseSize) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await compose({
        cutoutUrl,
        backdropUrl: selectedBackdrop.image_url,
        overlayUrl: selectedOverlay ? selectedOverlay.image_url : null,
        overlayPos,
        targetW: baseSize.w,
        targetH: baseSize.h,
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

  const overlayStyle = (() => {
    if (overlayPos === "top") return { top: 0, left: 0, width: "100%" } as const;
    if (overlayPos === "bottom") return { bottom: 0, left: 0, width: "100%" } as const;
    const base = { width: "25%" } as const;
    const pad = "2.5%";
    if (overlayPos === "tl") return { ...base, top: pad, left: pad };
    if (overlayPos === "tr") return { ...base, top: pad, right: pad };
    if (overlayPos === "bl") return { ...base, bottom: pad, left: pad };
    return { ...base, bottom: pad, right: pad };
  })();

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
              {selectedBackdrop && (
                <img
                  src={selectedBackdrop.image_url}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                />
              )}
              {removing ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-sm">
                  <div className="text-center">
                    <div className="h-8 w-8 mx-auto mb-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                    <p className="text-sm font-medium text-foreground">Cutting out the car…</p>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      First use downloads a ~40MB model. This happens entirely in your browser.
                    </p>
                  </div>
                </div>
              ) : removeErr ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-6">
                  <p className="text-sm text-destructive text-center">{removeErr}</p>
                </div>
              ) : cutoutUrl ? (
                <img
                  src={cutoutUrl}
                  alt=""
                  className="absolute inset-0 w-full h-full object-contain"
                />
              ) : null}
              {selectedOverlay && (
                <img
                  src={selectedOverlay.image_url}
                  alt=""
                  className="absolute pointer-events-none object-contain"
                  style={overlayStyle}
                />
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
                disabled={saving || removing || !cutoutUrl || !selectedBackdrop}
                className="rounded-md border border-border bg-secondary px-4 py-2 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save as new photo"}
              </button>
              <button
                onClick={() => {
                  if (confirm("Overwrite the original photo? This cannot be undone.")) void save("overwrite");
                }}
                disabled={saving || removing || !cutoutUrl || !selectedBackdrop}
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
