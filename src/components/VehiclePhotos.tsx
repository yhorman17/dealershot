import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { OverlayEditor } from "@/components/OverlayEditor";
import { BackgroundEditor } from "@/components/BackgroundEditor";
import { enqueueCutout, isExteriorShot, subscribeProcessing } from "@/lib/cutout-queue";
import { toast } from "sonner";

export const SHOT_TYPES = [
  { name: "Front", tip: "Stand 10-15 feet away, camera at headlight height, entire front bumper in frame." },
  { name: "Rear", tip: "Stand 10-15 feet away, camera at taillight height, entire rear bumper in frame." },
  { name: "Driver Side", tip: "Stand back so the full side profile is in frame, camera at door handle height." },
  { name: "Passenger Side", tip: "Same as driver side — full side profile, level with door handles." },
  { name: "Front 3/4", tip: "Stand at the front-driver corner. Capture both front and driver side in one shot." },
  { name: "Rear 3/4", tip: "Stand at the rear-passenger corner. Capture both rear and passenger side." },
  { name: "Dashboard", tip: "Open driver door, shoot the dashboard straight on with steering wheel centered." },
  { name: "Seats", tip: "Shoot from the open door showing front and rear seats clearly." },
  { name: "Trunk", tip: "Open the trunk fully, shoot from a few feet back showing the entire cargo area." },
  { name: "Engine", tip: "Open the hood and prop it. Shoot from the front showing the full engine bay." },
  { name: "Odometer", tip: "Turn ignition to ACC, get close to the cluster, mileage clearly readable." },
] as const;

const STANDARD_SHOT_NAMES: Set<string> = new Set(SHOT_TYPES.map((s) => s.name));

type Photo = {
  id: string;
  vehicle_id: string;
  image_url: string;
  shot_type: string | null;
  created_at: string;
  sort_order: number;
  is_main: boolean;
  is_cutout?: boolean;
  cutout_status?: string;
};

type VehicleDocument = {
  id: string;
  vehicle_id: string;
  document_id: string;
  sort_order: number;
  is_main: boolean;
  created_at: string;
  document: { id: string; name: string; image_url: string };
};

type GalleryItem = {
  key: string;
  kind: "photo" | "document";
  image_url: string;
  label: string;
  sort_order: number;
  is_main: boolean;
  created_at: string;
  photo?: Photo;
  link?: VehicleDocument;
};

function sortItems(items: GalleryItem[]): GalleryItem[] {
  return [...items].sort((a, b) => {
    if (a.is_main && !b.is_main) return -1;
    if (!a.is_main && b.is_main) return 1;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.created_at.localeCompare(b.created_at);
  });
}

type LibraryDoc = { id: string; name: string; image_url: string };

export function VehiclePhotos({ vehicleId }: { vehicleId: string }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [docLinks, setDocLinks] = useState<VehicleDocument[]>([]);
  const [mode, setMode] = useState<"guided" | "free">("guided");
  const [uploading, setUploading] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);
  const [dealershipId, setDealershipId] = useState<string | null>(null);
  const [overlayPhoto, setOverlayPhoto] = useState<Photo | null>(null);
  const [bgPhoto, setBgPhoto] = useState<Photo | null>(null);
  const [showAttachDoc, setShowAttachDoc] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from("vehicles")
        .select("dealership_id")
        .eq("id", vehicleId)
        .maybeSingle();
      setDealershipId((data?.dealership_id as string) || null);
    })();
  }, [vehicleId]);

  const load = async () => {
    const [{ data: ph }, { data: vd }] = await Promise.all([
      supabase
        .from("photos")
        .select("id, vehicle_id, image_url, shot_type, created_at, sort_order, is_main, is_cutout, cutout_status")
        .eq("vehicle_id", vehicleId),
      supabase
        .from("vehicle_documents")
        .select("id, vehicle_id, document_id, sort_order, is_main, created_at, document:documents(id, name, image_url)")
        .eq("vehicle_id", vehicleId),
    ]);
    setPhotos((ph as Photo[]) || []);
    setDocLinks((vd as unknown as VehicleDocument[]) || []);
  };

  useEffect(() => {
    void load();
  }, [vehicleId]);

  // Subscribe to in-memory processing queue so badges update live.
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  useEffect(() => subscribeProcessing(setProcessingIds), []);

  const items: GalleryItem[] = useMemo(() => {
    const all: GalleryItem[] = [
      ...photos.map<GalleryItem>((p) => ({
        key: `p:${p.id}`,
        kind: "photo",
        image_url: p.image_url,
        label: p.shot_type || "",
        sort_order: p.sort_order,
        is_main: p.is_main,
        created_at: p.created_at,
        photo: p,
      })),
      ...docLinks.map<GalleryItem>((l) => ({
        key: `d:${l.id}`,
        kind: "document",
        image_url: l.document?.image_url || "",
        label: l.document?.name || "Document",
        sort_order: l.sort_order,
        is_main: l.is_main,
        created_at: l.created_at,
        link: l,
      })),
    ];
    return sortItems(all);
  }, [photos, docLinks]);

  const maxSort = () => items.reduce((m, i) => Math.max(m, i.sort_order), -1);

  const uploadFile = async (file: File, shotType: string | null): Promise<Photo | null> => {
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${vehicleId}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage.from("vehicle-photos").upload(path, file, {
      contentType: file.type || "image/jpeg",
      upsert: false,
    });
    if (upErr) { alert(upErr.message); return null; }
    const { data: pub } = supabase.storage.from("vehicle-photos").getPublicUrl(path);
    const { data, error } = await supabase
      .from("photos")
      .insert({
        vehicle_id: vehicleId,
        image_url: pub.publicUrl,
        shot_type: shotType,
        sort_order: maxSort() + 1,
      })
      .select("id, vehicle_id, image_url, shot_type, created_at, sort_order, is_main")
      .single();
    if (error) { alert(error.message); return null; }
    return data as Photo;
  };

  const queueCutoutIfEligible = (photo: Photo) => {
    if (!isExteriorShot(photo.shot_type)) return;
    enqueueCutout(photo.id, photo.image_url, (res) => {
      if (res.ok) {
        void load();
      } else {
        toast.error("Cutout failed — using original");
        void load();
      }
    });
  };

  const handleGuidedUpload = async (shotName: string, file: File) => {
    setUploading(shotName);
    const existing = photos.find((p) => p.shot_type === shotName);
    const created = await uploadFile(file, shotName);
    if (created && existing) await deletePhoto(existing, true);
    if (created) {
      await load();
      queueCutoutIfEligible(created);
    }
    setUploading(null);
  };

  const handleFreeUpload = async (files: FileList, shotType: string | null) => {
    setUploading("free");
    for (const file of Array.from(files)) await uploadFile(file, shotType);
    await load();
    setUploading(null);
  };

  const handleCustomUpload = async (file: File) => {
    const label = customLabel.trim();
    if (!label) return;
    setUploading(`custom:${label}`);
    await uploadFile(file, label);
    await load();
    setUploading(null);
    setCustomLabel("");
    setAddingCustom(false);
  };

  const deletePhoto = async (photo: Photo, skipConfirm = false) => {
    if (!skipConfirm && !confirm("Delete this photo?")) return;
    try {
      const url = new URL(photo.image_url);
      const idx = url.pathname.indexOf("/vehicle-photos/");
      if (idx !== -1) {
        const path = url.pathname.slice(idx + "/vehicle-photos/".length);
        await supabase.storage.from("vehicle-photos").remove([path]);
      }
    } catch { /* ignore */ }
    await supabase.from("photos").delete().eq("id", photo.id);
    if (!skipConfirm) await load();
  };

  const detachDocument = async (link: VehicleDocument) => {
    if (!confirm(`Detach "${link.document?.name}" from this vehicle? The document stays in your library.`)) return;
    await supabase.from("vehicle_documents").delete().eq("id", link.id);
    await load();
  };

  const clearAllMains = async () => {
    // Clear is_main across both tables to enforce single main
    await supabase.from("photos").update({ is_main: false }).eq("vehicle_id", vehicleId).eq("is_main", true);
    await supabase.from("vehicle_documents").update({ is_main: false }).eq("vehicle_id", vehicleId).eq("is_main", true);
  };

  const setAsMain = async (item: GalleryItem) => {
    if (item.is_main) return;
    await clearAllMains();
    if (item.kind === "photo" && item.photo) {
      await supabase.from("photos").update({ is_main: true }).eq("id", item.photo.id);
    } else if (item.kind === "document" && item.link) {
      await supabase.from("vehicle_documents").update({ is_main: true }).eq("id", item.link.id);
    }
    await load();
  };

  const moveItem = async (item: GalleryItem, direction: -1 | 1) => {
    const orderedNonMain = sortItems(items).filter((i) => !i.is_main);
    const idx = orderedNonMain.findIndex((i) => i.key === item.key);
    const targetIdx = idx + direction;
    if (idx === -1 || targetIdx < 0 || targetIdx >= orderedNonMain.length) return;
    const other = orderedNonMain[targetIdx];
    const a = item.sort_order;
    const b = other.sort_order;
    const newA = b === a ? a + direction : b;
    const newB = b === a ? a : a;
    const updateOne = async (i: GalleryItem, val: number) => {
      if (i.kind === "photo" && i.photo) {
        await supabase.from("photos").update({ sort_order: val }).eq("id", i.photo.id);
      } else if (i.kind === "document" && i.link) {
        await supabase.from("vehicle_documents").update({ sort_order: val }).eq("id", i.link.id);
      }
    };
    await updateOne(item, newA);
    await updateOne(other, newB);
    await load();
  };

  const attachDocument = async (doc: LibraryDoc) => {
    const { error } = await supabase.from("vehicle_documents").insert({
      vehicle_id: vehicleId,
      document_id: doc.id,
      sort_order: maxSort() + 1,
    });
    if (error) { alert(error.message); return; }
    setShowAttachDoc(false);
    await load();
  };

  const completed = SHOT_TYPES.filter((s) => photos.some((p) => p.shot_type === s.name)).length;
  const customShots = photos.filter((p) => p.shot_type && !STANDARD_SHOT_NAMES.has(p.shot_type));
  const orderedNonMain = sortItems(items).filter((i) => !i.is_main);
  const attachedDocIds = new Set(docLinks.map((l) => l.document_id));

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex border-b border-border">
        {(["guided", "free"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              mode === m ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {m === "guided" ? "Guided Mode" : "Free Upload"}
          </button>
        ))}
      </div>

      {mode === "guided" ? (
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-card-foreground">Standard Shot Checklist</h3>
            <span className="text-xs text-muted-foreground">
              {completed} of {SHOT_TYPES.length} shots complete
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden mb-6">
            <div className="h-full bg-primary transition-all" style={{ width: `${(completed / SHOT_TYPES.length) * 100}%` }} />
          </div>
          <ul className="space-y-3">
            {SHOT_TYPES.map((shot) => {
              const taken = photos.find((p) => p.shot_type === shot.name);
              return (
                <li key={shot.name} className="flex flex-col sm:flex-row items-start gap-3 sm:gap-4 p-3 rounded-lg border border-border bg-background">
                  <div className="flex items-start gap-3 sm:contents w-full">
                    <div className="flex-shrink-0 w-16 h-16 sm:w-20 sm:h-20 rounded-md overflow-hidden bg-secondary flex items-center justify-center">
                      {taken ? (
                        <img src={taken.image_url} alt={shot.name} className="w-full h-full object-contain bg-background" />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {taken && (
                          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-500/20 text-green-400 text-[10px]">✓</span>
                        )}
                        <h4 className="text-sm font-medium text-card-foreground">{shot.name}</h4>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{shot.tip}</p>
                    </div>
                  </div>
                  <label className="w-full sm:w-auto sm:flex-shrink-0 cursor-pointer rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] flex items-center justify-center text-xs font-medium text-secondary-foreground hover:bg-secondary/80">
                    {uploading === shot.name ? "..." : taken ? "Replace" : "Capture"}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      disabled={uploading !== null}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleGuidedUpload(shot.name, f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </li>
              );
            })}
          </ul>

          <div className="mt-6 pt-6 border-t border-border">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-card-foreground">Custom Shots</h3>
              <span className="text-xs text-muted-foreground">{customShots.length} added</span>
            </div>

            {customShots.length > 0 && (
              <ul className="space-y-2 mb-3">
                {customShots.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 p-2 rounded-md border border-border bg-background">
                    <div className="flex-shrink-0 w-12 h-12 rounded overflow-hidden bg-background">
                      <img src={p.image_url} alt={p.shot_type || ""} className="w-full h-full object-contain" />
                    </div>
                    <span className="flex-1 text-sm text-card-foreground truncate">{p.shot_type}</span>
                  </li>
                ))}
              </ul>
            )}

            {addingCustom ? (
              <div className="space-y-2 p-3 rounded-md border border-border bg-background">
                <label className="block text-xs font-medium text-card-foreground">Custom shot label</label>
                <input
                  type="text"
                  value={customLabel}
                  onChange={(e) => setCustomLabel(e.target.value)}
                  placeholder="e.g. Window Sticker, Sunroof, Damage - rear bumper"
                  className="form-input"
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <label className={`flex-1 text-center cursor-pointer rounded-md px-3 py-2 text-sm font-medium ${
                    customLabel.trim() ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-secondary text-muted-foreground cursor-not-allowed"
                  }`}>
                    {uploading?.startsWith("custom:") ? "Uploading…" : "Capture / Upload"}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      disabled={!customLabel.trim() || uploading !== null}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleCustomUpload(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <button
                    onClick={() => { setAddingCustom(false); setCustomLabel(""); }}
                    className="rounded-md border border-border bg-secondary px-3 py-2 text-sm text-secondary-foreground hover:bg-secondary/80"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingCustom(true)}
                className="w-full rounded-md border border-dashed border-border bg-background px-4 py-3 text-sm font-medium text-card-foreground hover:border-primary/60 hover:text-primary transition-colors"
              >
                + Add Custom Shot
              </button>
            )}

            <button
              onClick={() => setShowAttachDoc(true)}
              className="mt-3 w-full rounded-md border border-dashed border-border bg-background px-4 py-3 text-sm font-medium text-card-foreground hover:border-primary/60 hover:text-primary transition-colors"
            >
              + Attach Document from Library
            </button>
          </div>
        </div>
      ) : (
        <FreeUploadPanel
          uploading={uploading === "free"}
          onUpload={handleFreeUpload}
          onAttachDocument={() => setShowAttachDoc(true)}
        />
      )}

      {/* Gallery */}
      <div className="border-t border-border p-6">
        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-card-foreground">All Photos ({items.length})</h3>
          {photos.some((p) => isExteriorShot(p.shot_type)) && (
            <button
              onClick={() => {
                const eligible = photos.filter((p) => isExteriorShot(p.shot_type));
                if (eligible.length === 0) return;
                if (!confirm(`This will re-run background removal on ${eligible.length} exterior shot${eligible.length === 1 ? "" : "s"}. Continue?`)) return;
                eligible.forEach((p) => {
                  enqueueCutout(p.id, p.image_url, (res) => {
                    if (!res.ok) toast.error(`Cutout failed for ${p.shot_type ?? "photo"}`);
                    void load();
                  });
                });
              }}
              className="text-xs text-primary hover:underline"
            >
              Re-process all exterior shots
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No photos yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {sortItems(items).map((it) => {
              const nonMainIdx = it.is_main ? -1 : orderedNonMain.findIndex((x) => x.key === it.key);
              const canMoveUp = !it.is_main && nonMainIdx > 0;
              const canMoveDown = !it.is_main && nonMainIdx !== -1 && nonMainIdx < orderedNonMain.length - 1;
              const isDoc = it.kind === "document";
              const photo = it.photo;
              const processing = !!photo && (processingIds.has(photo.id) || photo.cutout_status === "pending");
              const isCutout = !!photo?.is_cutout;
              return (
                <div key={it.key} className={`group relative rounded-md overflow-hidden bg-background ${it.is_main ? "ring-2 ring-primary" : ""}`}>
                  <div
                    className="aspect-square relative"
                    style={isCutout ? {
                      backgroundImage:
                        "linear-gradient(45deg, rgba(255,255,255,0.04) 25%, transparent 25%), linear-gradient(-45deg, rgba(255,255,255,0.04) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.04) 75%), linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.04) 75%)",
                      backgroundSize: "16px 16px",
                      backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
                    } : undefined}
                  >
                    <img src={it.image_url} alt={it.label} className="w-full h-full object-contain" />

                    {it.label && (
                      <span className="absolute top-1.5 left-1.5 inline-flex items-center rounded bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-medium text-white max-w-[80%] truncate">
                        {it.label}
                      </span>
                    )}

                    {processing && (
                      <div className="absolute inset-0 flex items-end justify-center pb-2 pointer-events-none">
                        <span className="inline-flex items-center gap-1.5 rounded bg-black/70 backdrop-blur-sm px-2 py-1 text-[10px] font-medium text-white animate-pulse">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
                          Processing cutout…
                        </span>
                      </div>
                    )}

                    <div className="absolute top-1.5 right-1.5 flex flex-col items-end gap-1">
                      {it.is_main && (
                        <span className="inline-flex items-center rounded bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white">
                          MAIN
                        </span>
                      )}
                      {isDoc && (
                        <span className="inline-flex items-center rounded bg-primary/90 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-primary-foreground">
                          DOCUMENT
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 p-2 bg-background border-t border-border">
                    {!it.is_main && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => void moveItem(it, -1)}
                          disabled={!canMoveUp}
                          aria-label="Move earlier"
                          className="h-11 w-11 flex items-center justify-center rounded bg-secondary text-foreground text-lg font-semibold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-secondary/80"
                        >↑</button>
                        <button
                          onClick={() => void moveItem(it, 1)}
                          disabled={!canMoveDown}
                          aria-label="Move later"
                          className="h-11 w-11 flex items-center justify-center rounded bg-secondary text-foreground text-lg font-semibold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-secondary/80"
                        >↓</button>
                      </div>
                    )}
                    <div className="flex flex-wrap items-stretch gap-1.5">
                      {!isDoc && dealershipId && it.photo && (
                        <>
                          <button
                            onClick={() => setOverlayPhoto(it.photo!)}
                            className="flex-1 min-w-[6.5rem] min-h-[44px] rounded bg-secondary px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-secondary/80"
                          >
                            Add Overlay
                          </button>
                          <button
                            onClick={() => setBgPhoto(it.photo!)}
                            className="flex-1 min-w-[6.5rem] min-h-[44px] rounded bg-secondary px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-secondary/80"
                          >
                            Change BG
                          </button>
                        </>
                      )}
                      {!it.is_main && (
                        <button
                          onClick={() => void setAsMain(it)}
                          className="flex-1 min-w-[6.5rem] min-h-[44px] rounded bg-secondary px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-secondary/80"
                        >
                          Set as main
                        </button>
                      )}
                      {isDoc ? (
                        <button
                          onClick={() => void detachDocument(it.link!)}
                          className="flex-1 min-w-[6.5rem] min-h-[44px] rounded border border-border bg-secondary px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-secondary/80"
                        >
                          Detach
                        </button>
                      ) : (
                        <button
                          onClick={() => void deletePhoto(it.photo!)}
                          className="flex-1 min-w-[6.5rem] min-h-[44px] rounded bg-destructive px-2 py-1.5 text-[11px] font-medium text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {overlayPhoto && dealershipId && (
        <OverlayEditor
          photo={overlayPhoto}
          dealershipId={dealershipId}
          onClose={() => setOverlayPhoto(null)}
          onSaved={() => { setOverlayPhoto(null); void load(); }}
        />
      )}

      {bgPhoto && dealershipId && (
        <BackgroundEditor
          photo={bgPhoto}
          dealershipId={dealershipId}
          onClose={() => setBgPhoto(null)}
          onSaved={() => { setBgPhoto(null); void load(); }}
        />
      )}

      {showAttachDoc && dealershipId && (
        <PickDocumentModal
          dealershipId={dealershipId}
          alreadyAttached={attachedDocIds}
          onClose={() => setShowAttachDoc(false)}
          onPick={(d) => void attachDocument(d)}
        />
      )}
    </div>
  );
}

function FreeUploadPanel({
  uploading,
  onUpload,
  onAttachDocument,
}: {
  uploading: boolean;
  onUpload: (files: FileList, shotType: string | null) => Promise<void>;
  onAttachDocument: () => void;
}) {
  const [shotType, setShotType] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="p-6">
      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-card-foreground mb-1.5">Tag with shot type (optional)</label>
          <select value={shotType} onChange={(e) => setShotType(e.target.value)} className="form-input">
            <option value="">No tag</option>
            {SHOT_TYPES.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </div>
      </div>
      <label className="block cursor-pointer rounded-lg border-2 border-dashed border-border bg-background p-10 text-center hover:border-primary/60 transition-colors">
        <p className="text-sm font-medium text-card-foreground">
          {uploading ? "Uploading…" : "Tap to take a photo or select images"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">You can select multiple files at once</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) void onUpload(e.target.files, shotType || null);
            e.target.value = "";
          }}
        />
      </label>
      <button
        onClick={onAttachDocument}
        className="mt-3 w-full rounded-md border border-dashed border-border bg-background px-4 py-3 text-sm font-medium text-card-foreground hover:border-primary/60 hover:text-primary transition-colors"
      >
        + Attach Document from Library
      </button>
    </div>
  );
}

function PickDocumentModal({
  dealershipId,
  alreadyAttached,
  onClose,
  onPick,
}: {
  dealershipId: string;
  alreadyAttached: Set<string>;
  onClose: () => void;
  onPick: (doc: LibraryDoc) => void;
}) {
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from("documents")
        .select("id, name, image_url")
        .eq("dealership_id", dealershipId)
        .order("created_at", { ascending: false });
      setDocs((data as LibraryDoc[]) || []);
      setLoading(false);
    })();
  }, [dealershipId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-xl border border-border bg-card p-6 shadow-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-card-foreground">Attach Document</h2>
          <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">Close</button>
        </div>
        {loading ? (
          <div className="text-sm text-muted-foreground text-center py-10">Loading…</div>
        ) : docs.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-10 rounded-md border border-dashed border-border">
            No documents in the library yet. Add one from the Documents page.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
            {docs.map((d) => {
              const attached = alreadyAttached.has(d.id);
              return (
                <button
                  key={d.id}
                  disabled={attached}
                  onClick={() => onPick(d)}
                  className={`text-left rounded-lg border border-border bg-background overflow-hidden hover:border-primary transition-colors ${attached ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <div className="aspect-[16/9] bg-secondary flex items-center justify-center">
                    <img src={d.image_url} alt={d.name} className="max-w-full max-h-full object-contain" />
                  </div>
                  <div className="p-3">
                    <p className="text-sm font-medium text-card-foreground truncate">{d.name}</p>
                    {attached && <p className="text-[11px] text-muted-foreground mt-0.5">Already attached</p>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
