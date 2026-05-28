import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { OverlayEditor } from "@/components/OverlayEditor";

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
};

/**
 * Returns photos ordered with the main photo first, then by sort_order, then created_at.
 */
function sortPhotos(photos: Photo[]): Photo[] {
  return [...photos].sort((a, b) => {
    if (a.is_main && !b.is_main) return -1;
    if (!a.is_main && b.is_main) return 1;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.created_at.localeCompare(b.created_at);
  });
}

export function VehiclePhotos({ vehicleId }: { vehicleId: string }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [mode, setMode] = useState<"guided" | "free">("guided");
  const [uploading, setUploading] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);
  const [dealershipId, setDealershipId] = useState<string | null>(null);
  const [overlayPhoto, setOverlayPhoto] = useState<Photo | null>(null);

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
    const { data } = await supabase
      .from("photos")
      .select("id, vehicle_id, image_url, shot_type, created_at, sort_order, is_main")
      .eq("vehicle_id", vehicleId);
    setPhotos(sortPhotos((data as Photo[]) || []));
  };

  useEffect(() => {
    void load();
  }, [vehicleId]);

  const uploadFile = async (file: File, shotType: string | null): Promise<Photo | null> => {
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${vehicleId}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage.from("vehicle-photos").upload(path, file, {
      contentType: file.type || "image/jpeg",
      upsert: false,
    });
    if (upErr) {
      alert(upErr.message);
      return null;
    }
    const { data: pub } = supabase.storage.from("vehicle-photos").getPublicUrl(path);
    // Assign sort_order as max+1 so new photos go to the end
    const maxSort = photos.reduce((m, p) => Math.max(m, p.sort_order), -1);
    const { data, error } = await supabase
      .from("photos")
      .insert({
        vehicle_id: vehicleId,
        image_url: pub.publicUrl,
        shot_type: shotType,
        sort_order: maxSort + 1,
      })
      .select("id, vehicle_id, image_url, shot_type, created_at, sort_order, is_main")
      .single();
    if (error) {
      alert(error.message);
      return null;
    }
    return data as Photo;
  };

  const handleGuidedUpload = async (shotName: string, file: File) => {
    setUploading(shotName);
    const existing = photos.find((p) => p.shot_type === shotName);
    const created = await uploadFile(file, shotName);
    if (created && existing) {
      await deletePhoto(existing, true);
    }
    if (created) {
      await load();
    }
    setUploading(null);
  };

  const handleFreeUpload = async (files: FileList, shotType: string | null) => {
    setUploading("free");
    for (const file of Array.from(files)) {
      await uploadFile(file, shotType);
    }
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
    } catch {
      // ignore parse errors; still delete row
    }
    await supabase.from("photos").delete().eq("id", photo.id);
    if (!skipConfirm) await load();
  };

  const setAsMain = async (photo: Photo) => {
    if (photo.is_main) return;
    // Clear any existing main first to satisfy unique-index constraint
    await supabase
      .from("photos")
      .update({ is_main: false })
      .eq("vehicle_id", vehicleId)
      .eq("is_main", true);
    const { error } = await supabase
      .from("photos")
      .update({ is_main: true })
      .eq("id", photo.id);
    if (error) {
      alert(error.message);
      return;
    }
    await load();
  };

  const movePhoto = async (photo: Photo, direction: -1 | 1) => {
    // Reorder amongst non-main photos only; main is pinned first
    const ordered = sortPhotos(photos).filter((p) => !p.is_main);
    const idx = ordered.findIndex((p) => p.id === photo.id);
    const targetIdx = idx + direction;
    if (idx === -1 || targetIdx < 0 || targetIdx >= ordered.length) return;
    const other = ordered[targetIdx];
    // Swap sort_order values
    const a = photo.sort_order;
    const b = other.sort_order;
    const newA = b === a ? a + direction : b;
    const newB = b === a ? a : a;
    await supabase.from("photos").update({ sort_order: newA }).eq("id", photo.id);
    await supabase.from("photos").update({ sort_order: newB }).eq("id", other.id);
    await load();
  };

  const completed = SHOT_TYPES.filter((s) => photos.some((p) => p.shot_type === s.name)).length;
  const customShots = photos.filter((p) => p.shot_type && !STANDARD_SHOT_NAMES.has(p.shot_type));
  const orderedNonMain = sortPhotos(photos).filter((p) => !p.is_main);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex border-b border-border">
        {(["guided", "free"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              mode === m
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
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
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${(completed / SHOT_TYPES.length) * 100}%` }}
            />
          </div>
          <ul className="space-y-3">
            {SHOT_TYPES.map((shot) => {
              const taken = photos.find((p) => p.shot_type === shot.name);
              return (
                <li
                  key={shot.name}
                  className="flex items-start gap-4 p-3 rounded-lg border border-border bg-background"
                >
                  <div className="flex-shrink-0 w-20 h-20 rounded-md overflow-hidden bg-secondary flex items-center justify-center">
                    {taken ? (
                      <img src={taken.image_url} alt={shot.name} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {taken && (
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-500/20 text-green-400 text-[10px]">
                          ✓
                        </span>
                      )}
                      <h4 className="text-sm font-medium text-card-foreground">{shot.name}</h4>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{shot.tip}</p>
                  </div>
                  <label className="flex-shrink-0 cursor-pointer rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80">
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

          {/* Custom shots section */}
          <div className="mt-6 pt-6 border-t border-border">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-card-foreground">Custom Shots</h3>
              <span className="text-xs text-muted-foreground">{customShots.length} added</span>
            </div>

            {customShots.length > 0 && (
              <ul className="space-y-2 mb-3">
                {customShots.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-3 p-2 rounded-md border border-border bg-background"
                  >
                    <div className="flex-shrink-0 w-12 h-12 rounded overflow-hidden bg-secondary">
                      <img src={p.image_url} alt={p.shot_type || ""} className="w-full h-full object-cover" />
                    </div>
                    <span className="flex-1 text-sm text-card-foreground truncate">{p.shot_type}</span>
                  </li>
                ))}
              </ul>
            )}

            {addingCustom ? (
              <div className="space-y-2 p-3 rounded-md border border-border bg-background">
                <label className="block text-xs font-medium text-card-foreground">
                  Custom shot label
                </label>
                <input
                  type="text"
                  value={customLabel}
                  onChange={(e) => setCustomLabel(e.target.value)}
                  placeholder="e.g. Window Sticker, Sunroof, Damage - rear bumper"
                  className="form-input"
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <label
                    className={`flex-1 text-center cursor-pointer rounded-md px-3 py-2 text-sm font-medium ${
                      customLabel.trim()
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "bg-secondary text-muted-foreground cursor-not-allowed"
                    }`}
                  >
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
                    onClick={() => {
                      setAddingCustom(false);
                      setCustomLabel("");
                    }}
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
          </div>
        </div>
      ) : (
        <FreeUploadPanel
          uploading={uploading === "free"}
          onUpload={handleFreeUpload}
        />
      )}

      {/* Gallery */}
      <div className="border-t border-border p-6">
        <h3 className="text-sm font-semibold text-card-foreground mb-4">
          All Photos ({photos.length})
        </h3>
        {photos.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No photos yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {sortPhotos(photos).map((p) => {
              const nonMainIdx = p.is_main ? -1 : orderedNonMain.findIndex((x) => x.id === p.id);
              const canMoveUp = !p.is_main && nonMainIdx > 0;
              const canMoveDown = !p.is_main && nonMainIdx !== -1 && nonMainIdx < orderedNonMain.length - 1;
              return (
                <div
                  key={p.id}
                  className={`group relative rounded-md overflow-hidden bg-secondary ${
                    p.is_main ? "ring-2 ring-primary" : ""
                  }`}
                >
                  <div className="aspect-square relative">
                    <img src={p.image_url} alt={p.shot_type || "Photo"} className="w-full h-full object-cover" />

                    {/* Top-left: shot type label */}
                    {p.shot_type && (
                      <span className="absolute top-1.5 left-1.5 inline-flex items-center rounded bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {p.shot_type}
                      </span>
                    )}

                    {/* Top-right: MAIN badge */}
                    {p.is_main && (
                      <span className="absolute top-1.5 right-1.5 inline-flex items-center rounded bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white">
                        MAIN
                      </span>
                    )}
                  </div>

                  {/* Bottom control bar */}
                  <div className="flex items-center justify-between p-2 bg-background border-t border-border">
                    <div className="flex items-center gap-1">
                      {!p.is_main && (
                        <>
                          <button
                            onClick={() => void movePhoto(p, -1)}
                            disabled={!canMoveUp}
                            aria-label="Move earlier"
                            className="h-10 w-10 flex items-center justify-center rounded bg-secondary text-foreground text-lg font-semibold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-secondary/80"
                          >
                            ↑
                          </button>
                          <button
                            onClick={() => void movePhoto(p, 1)}
                            disabled={!canMoveDown}
                            aria-label="Move later"
                            className="h-10 w-10 flex items-center justify-center rounded bg-secondary text-foreground text-lg font-semibold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-secondary/80"
                          >
                            ↓
                          </button>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {!p.is_main && (
                        <button
                          onClick={() => void setAsMain(p)}
                          className="rounded bg-secondary px-2 py-1.5 text-[10px] font-medium text-foreground hover:bg-secondary/80"
                        >
                          Set as main
                        </button>
                      )}
                      <button
                        onClick={() => void deletePhoto(p)}
                        className="rounded bg-destructive px-2 py-1.5 text-[10px] font-medium text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FreeUploadPanel({
  uploading,
  onUpload,
}: {
  uploading: boolean;
  onUpload: (files: FileList, shotType: string | null) => Promise<void>;
}) {
  const [shotType, setShotType] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="p-6">
      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-card-foreground mb-1.5">
            Tag with shot type (optional)
          </label>
          <select
            value={shotType}
            onChange={(e) => setShotType(e.target.value)}
            className="form-input"
          >
            <option value="">No tag</option>
            {SHOT_TYPES.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
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
            if (e.target.files && e.target.files.length > 0) {
              void onUpload(e.target.files, shotType || null);
            }
            e.target.value = "";
          }}
        />
      </label>
    </div>
  );
}
