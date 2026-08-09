import { useEffect, useRef, useState } from "react";
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

export type OverlayTemplate = {
  id: string;
  name: string;
  image_url: string;
  category: string | null;
};

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

/**
 * Computes the destination rect for the overlay on a canvas sized like the base photo.
 * - top/bottom: full width, height scaled to preserve overlay aspect ratio.
 * - corners: 25% of the base width, height scaled to preserve aspect ratio, with 2.5% padding.
 */
function destRect(
  baseW: number,
  baseH: number,
  ovW: number,
  ovH: number,
  pos: Position,
): { x: number; y: number; w: number; h: number } {
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

async function compositeToBlob(photoUrl: string, overlayUrl: string, pos: Position): Promise<Blob> {
  const [base, overlay] = await Promise.all([loadImage(photoUrl), loadImage(overlayUrl)]);
  const canvas = document.createElement("canvas");
  canvas.width = base.naturalWidth;
  canvas.height = base.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(base, 0, 0);
  const r = destRect(canvas.width, canvas.height, overlay.naturalWidth, overlay.naturalHeight, pos);
  ctx.drawImage(overlay, r.x, r.y, r.w, r.h);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Failed to render"))),
      "image/jpeg",
      0.92,
    );
  });
}

export function OverlayEditor({
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
  const [overlays, setOverlays] = useState<OverlayTemplate[]>([]);
  const [overlayId, setOverlayId] = useState<string>("");
  const [pos, setPos] = useState<Position>("bottom");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from("overlay_templates")
        .select("id, name, image_url, category")
        .eq("dealership_id", dealershipId)
        .order("created_at", { ascending: false });
      const list = (data as OverlayTemplate[]) || [];
      setOverlays(list);
      if (list.length > 0) setOverlayId(list[0].id);
    })();
  }, [dealershipId]);

  const selected = overlays.find((o) => o.id === overlayId);

  const save = async (mode: "new" | "overwrite") => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await compositeToBlob(photo.image_url, selected.image_url, pos);
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
          overlay_id: selected.id,
          sort_order: (photo.sort_order ?? 0) + 1,
        });
        if (insErr) throw insErr;
      } else {
        // Overwrite: replace existing row's image_url and delete old storage file
        try {
          const url = new URL(photo.image_url);
          const idx = url.pathname.indexOf("/vehicle-photos/");
          if (idx !== -1) {
            const oldPath = url.pathname.slice(idx + "/vehicle-photos/".length);
            await supabase.storage.from("vehicle-photos").remove([oldPath]);
          }
        } catch {
          // ignore
        }
        const { error: updErr } = await supabase
          .from("photos")
          .update({ image_url: pub.publicUrl, overlay_id: selected.id })
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

  // Build CSS for overlay preview matching the canvas math
  const overlayStyle = (() => {
    if (pos === "top") return { top: 0, left: 0, width: "100%" } as const;
    if (pos === "bottom") return { bottom: 0, left: 0, width: "100%" } as const;
    const base = { width: "25%" } as const;
    const pad = "2.5%";
    if (pos === "tl") return { ...base, top: pad, left: pad };
    if (pos === "tr") return { ...base, top: pad, right: pad };
    if (pos === "bl") return { ...base, bottom: pad, left: pad };
    return { ...base, bottom: pad, right: pad };
  })();

  return (
    <div className="motion-overlay-static fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 overflow-auto">
      <div className="motion-panel-static w-full max-w-3xl rounded-xl border border-border bg-card p-6 shadow-2xl my-8">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-card-foreground">Add Overlay</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Compose a banner onto this photo</p>
          </div>
          <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
            ✕
          </button>
        </div>

        {overlays.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-8 text-sm text-muted-foreground text-center">
            No overlays available for this dealership. Create one on the Overlays page first.
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-card-foreground mb-1.5">
                  Overlay
                </label>
                <select
                  value={overlayId}
                  onChange={(e) => setOverlayId(e.target.value)}
                  className="form-input"
                >
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
                  Position
                </label>
                <select
                  value={pos}
                  onChange={(e) => setPos(e.target.value as Position)}
                  className="form-input"
                >
                  {POSITIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div
              ref={previewRef}
              className="relative w-full rounded-lg overflow-hidden bg-secondary border border-border"
            >
              <img src={photo.image_url} alt="" className="w-full h-auto block" />
              {selected && (
                <img
                  src={selected.image_url}
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
                disabled={saving || !selected}
                className="rounded-md border border-border bg-secondary px-4 py-2 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save as new photo"}
              </button>
              <button
                onClick={() => {
                  if (confirm("Overwrite the original photo? This cannot be undone."))
                    void save("overwrite");
                }}
                disabled={saving || !selected}
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
