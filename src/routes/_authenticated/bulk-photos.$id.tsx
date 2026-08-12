import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Camera,
  Check,
  ImagePlus,
  RefreshCw,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { createUploadQueue, type UploadEntry } from "@/lib/upload-queue";
import { Button } from "@/components/ui/button";
import { PageHeader, ProductSelect, StatusBadge } from "@/components/product-ui";
import { SHOT_TYPES } from "@/components/VehiclePhotos";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/bulk-photos/$id")({
  head: () => ({ meta: [{ title: "Bulk Photo Package — DealerShot" }] }),
  component: BulkPhotoWorkspace,
});

type Session = {
  id: string;
  dealership_id: string;
  vehicle_id: string | null;
  vin: string | null;
  status: "in_progress" | "completed" | "prepared";
  created_by: string | null;
  completed_at: string | null;
};
type Item = {
  id: string;
  session_id: string;
  image_url: string;
  storage_path: string;
  shot_type: string | null;
  sort_order: number;
  is_main: boolean;
  photo_id: string | null;
  created_at: string;
};
type BulkUpload = { file: File };

async function decodeVehicleVin(vin: string) {
  try {
    const response = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`,
    );
    if (!response.ok) return {};
    const decoded = (await response.json())?.Results?.[0];
    if (!decoded) return {};
    const year = Number.parseInt(decoded.ModelYear, 10);
    const cylinders = Number.parseInt(decoded.EngineCylinders, 10);
    return {
      year: Number.isFinite(year) ? year : null,
      make: decoded.Make || null,
      model: decoded.Model || null,
      trim: decoded.Trim || null,
      body_class: decoded.BodyClass || null,
      engine: decoded.EngineModel || decoded.DisplacementL || null,
      cylinders: Number.isFinite(cylinders) ? cylinders : null,
      transmission: decoded.TransmissionStyle || null,
      drivetrain: decoded.DriveType || null,
      fuel_type: decoded.FuelTypePrimary || null,
    };
  } catch {
    // VIN decoding improves the lightweight intake, but never blocks durable
    // association when NHTSA is temporarily unavailable.
    return {};
  }
}

function BulkPhotoWorkspace() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queueEntries, setQueueEntries] = useState<UploadEntry<BulkUpload>[]>([]);
  const [completing, setCompleting] = useState(false);
  const [associating, setAssociating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextSortRef = useRef(0);

  const load = useCallback(async () => {
    const [{ data: sessionData, error: sessionError }, { data: itemData, error: itemError }] =
      await Promise.all([
        supabase
          .from("photo_capture_sessions")
          .select("id, dealership_id, vehicle_id, vin, status, created_by, completed_at")
          .eq("id", id)
          .maybeSingle(),
        supabase
          .from("bulk_photo_items")
          .select(
            "id, session_id, image_url, storage_path, shot_type, sort_order, is_main, photo_id, created_at",
          )
          .eq("session_id", id)
          .order("sort_order")
          .order("created_at"),
      ]);
    if (sessionError || itemError || !sessionData) {
      setError("This Bulk Photos package is unavailable or outside your dealership access.");
      return;
    }
    setSession(sessionData as Session);
    const nextItems = (itemData ?? []) as Item[];
    setItems(nextItems);
    nextSortRef.current = Math.max(
      nextSortRef.current,
      ...nextItems.map((item) => item.sort_order + 1),
    );
    setSelectedId((current) =>
      current && nextItems.some((item) => item.id === current)
        ? current
        : (nextItems[0]?.id ?? null),
    );
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const uploadQueue = useMemo(
    () =>
      createUploadQueue<BulkUpload>(
        async ({ file }) => {
          if (!user || !session || session.status !== "in_progress")
            throw new Error("This package is no longer accepting photos.");
          const extension = file.name.split(".").pop() || "jpg";
          const storagePath = `${session.id}/originals/${crypto.randomUUID()}.${extension}`;
          const { error: uploadError } = await supabase.storage
            .from("vehicle-photos")
            .upload(storagePath, file, { contentType: file.type || "image/jpeg", upsert: false });
          if (uploadError) throw uploadError;
          const imageUrl = supabase.storage.from("vehicle-photos").getPublicUrl(storagePath)
            .data.publicUrl;
          const sortOrder = nextSortRef.current;
          nextSortRef.current += 1;
          const { error: insertError } = await supabase.from("bulk_photo_items").insert({
            session_id: session.id,
            image_url: imageUrl,
            storage_path: storagePath,
            sort_order: sortOrder,
            created_by: user.id,
          });
          if (insertError) {
            await supabase.storage.from("vehicle-photos").remove([storagePath]);
            throw insertError;
          }
          await load();
        },
        { concurrency: 2 },
      ),
    [load, session, user],
  );
  useEffect(() => uploadQueue.subscribe(setQueueEntries), [uploadQueue]);

  const pending = queueEntries.filter(
    (entry) => entry.state === "queued" || entry.state === "uploading",
  ).length;
  const failed = queueEntries.filter((entry) => entry.state === "failed").length;
  const isAdmin = profile?.role === "owner" || profile?.role === "dealer_admin";
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const complete = async () => {
    setCompleting(true);
    await uploadQueue.waitForIdle();
    const failures = uploadQueue.getSnapshot().filter((entry) => entry.state === "failed").length;
    if (failures) {
      toast.error(`${failures} photos still need to upload`);
      setCompleting(false);
      return;
    }
    const { error: completeError } = await supabase.rpc("complete_photo_capture_session", {
      _session_id: id,
    });
    if (completeError)
      toast.error("Package could not be completed", { description: completeError.message });
    else {
      toast.success("Bulk Photos ready for office review");
      await load();
    }
    setCompleting(false);
  };

  const updateItem = async (
    item: Item,
    changes: Pick<Partial<Item>, "shot_type" | "sort_order" | "is_main">,
  ) => {
    if (changes.is_main)
      await supabase
        .from("bulk_photo_items")
        .update({ is_main: false })
        .eq("session_id", id)
        .eq("is_main", true);
    const { error: updateError } = await supabase
      .from("bulk_photo_items")
      .update(changes)
      .eq("id", item.id);
    if (updateError) toast.error("Photo update failed", { description: updateError.message });
    else await load();
  };
  const move = async (item: Item, direction: -1 | 1) => {
    const index = items.findIndex((candidate) => candidate.id === item.id);
    const target = items[index + direction];
    if (!target) return;
    const [{ error: firstError }, { error: secondError }] = await Promise.all([
      supabase.from("bulk_photo_items").update({ sort_order: target.sort_order }).eq("id", item.id),
      supabase.from("bulk_photo_items").update({ sort_order: item.sort_order }).eq("id", target.id),
    ]);
    if (firstError || secondError) {
      toast.error("Photo order could not be updated", {
        description: (firstError ?? secondError)?.message,
      });
    }
    await load();
  };
  const remove = async (item: Item) => {
    const { error: itemError } = await supabase.from("bulk_photo_items").delete().eq("id", item.id);
    if (itemError)
      return toast.error("Photo could not be removed", { description: itemError.message });
    const { error: storageError } = await supabase.storage
      .from("vehicle-photos")
      .remove([item.storage_path]);
    if (storageError)
      toast.warning("Photo removed, but storage cleanup needs attention", {
        description: storageError.message,
      });
    await load();
  };

  const associate = async (customizeItemId?: string) => {
    if (!session || !session.vin) return;
    setAssociating(true);
    try {
      let vehicleId = session.vehicle_id;
      if (!vehicleId) {
        const decoded = await decodeVehicleVin(session.vin);
        const { data: vehicle, error: vehicleError } = await supabase
          .from("vehicles")
          .insert({
            dealership_id: session.dealership_id,
            vin: session.vin,
            status: "Available",
            condition: "Used",
            ...decoded,
          })
          .select("id")
          .single();
        if (vehicleError) throw vehicleError;
        vehicleId = vehicle.id;
      }
      const { error: associateError } = await supabase.rpc("associate_bulk_photo_session", {
        _session_id: session.id,
        _vehicle_id: vehicleId,
      });
      if (associateError) throw associateError;
      let customizePhotoId: string | null = null;
      if (customizeItemId) {
        const { data: linkedItem, error: linkedItemError } = await supabase
          .from("bulk_photo_items")
          .select("photo_id")
          .eq("id", customizeItemId)
          .single();
        if (linkedItemError || !linkedItem?.photo_id) {
          toast.warning("Package associated, but the selected photo could not open automatically", {
            description: "Open Customize from the vehicle gallery to continue.",
          });
        } else {
          customizePhotoId = linkedItem.photo_id;
        }
      }
      toast.success("Bulk package associated without re-uploading photos", {
        description: session.vehicle_id
          ? "The originals are ready in the vehicle workspace."
          : "VIN details were loaded when available; review missing inventory fields next.",
      });
      navigate({
        to: "/vehicles/$id",
        params: { id: vehicleId },
        search: customizePhotoId ? { customize: customizePhotoId } : undefined,
      });
    } catch (reason) {
      toast.error("Package could not be associated", {
        description: reason instanceof Error ? reason.message : "Try again.",
      });
    } finally {
      setAssociating(false);
    }
  };

  if (error)
    return (
      <main className="ds-page-gutter">
        <div className="ds-surface p-8 text-center text-sm text-destructive">{error}</div>
      </main>
    );
  if (!session)
    return (
      <main className="ds-page-gutter">
        <div className="ds-surface p-8 text-center text-sm text-muted-foreground">
          Loading package…
        </div>
      </main>
    );

  return (
    <main className="ds-page-gutter">
      <Button asChild variant="ghost" className="mb-3 -ml-3">
        <Link to="/bulk-photos">
          <ArrowLeft className="size-4" />
          Bulk Photos
        </Link>
      </Button>
      <PageHeader
        eyebrow="Photo intake package"
        title={session.vin ?? "Bulk Photos"}
        description={`${items.length} raw originals · ${session.status === "completed" ? "Ready for office preparation" : session.status === "prepared" ? "Associated with inventory" : "Capture in progress"}`}
        actions={
          <StatusBadge tone={session.status === "completed" ? "success" : "info"}>
            {session.status === "completed"
              ? "Ready"
              : session.status === "prepared"
                ? "Prepared"
                : "In Progress"}
          </StatusBadge>
        }
      />

      {session.status === "in_progress" && (
        <section className="ds-surface mb-5 p-4 sm:p-5">
          <label className="motion-upload-target ds-grid-lines flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-input bg-secondary/25 p-6 text-center hover:border-primary/60">
            <span className="grid size-12 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Camera className="size-6" />
            </span>
            <strong className="mt-3 text-base">Capture or add photos</strong>
            <span className="mt-1 text-xs text-muted-foreground">
              Choose many files; uploads run two at a time while you continue.
            </span>
            <input
              className="hidden"
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              onChange={(event) => {
                if (event.target.files)
                  Array.from(event.target.files).forEach((file) => uploadQueue.add({ file }));
                event.target.value = "";
              }}
            />
          </label>
          <div
            className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
            aria-live="polite"
          >
            <div>
              <p className="text-sm font-semibold">{items.length} photos captured</p>
              <p className="text-xs text-muted-foreground">
                {failed
                  ? `${failed} failed — retry required`
                  : pending
                    ? `${pending} uploading`
                    : "All originals uploaded"}
              </p>
            </div>
            <div className="flex gap-2">
              {failed > 0 && (
                <Button variant="outline" onClick={() => uploadQueue.retryFailed()}>
                  <RefreshCw className="size-4" />
                  Retry Uploads
                </Button>
              )}
              <Button
                className="min-h-12 flex-1"
                onClick={() => void complete()}
                disabled={completing || items.length + pending + failed === 0}
              >
                <Check className="size-4" />
                {completing ? "Completing…" : "Complete Bulk Photos"}
              </Button>
            </div>
          </div>
        </section>
      )}

      {isAdmin && session.status === "completed" && (
        <section className="ds-surface mb-5 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold">Office preparation</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Order and tag the grid, then associate it to inventory. The same stored originals
                become vehicle photos.
              </p>
            </div>
            <Button onClick={() => void associate()} disabled={associating}>
              {associating
                ? "Associating…"
                : session.vehicle_id
                  ? "Associate Package"
                  : "Create Vehicle & Associate"}
            </Button>
          </div>
        </section>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Photo grid</h2>
            <span className="text-xs text-muted-foreground">Select a photo to organize</span>
          </div>
          {items.length === 0 ? (
            <div className="ds-surface p-10 text-center">
              <ImagePlus className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">No photos yet</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {items.map((item, index) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={`motion-card overflow-hidden rounded-lg border bg-card text-left ${selectedId === item.id ? "border-primary ring-2 ring-primary/25" : "border-border"}`}
                >
                  <div className="relative aspect-square bg-secondary">
                    <img
                      src={item.image_url}
                      alt={`Bulk photo ${index + 1}`}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    {item.is_main && (
                      <span className="absolute left-2 top-2 rounded bg-primary px-2 py-1 text-[10px] font-bold text-primary-foreground">
                        MAIN
                      </span>
                    )}
                    <span className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-[10px] font-bold text-white">
                      {index + 1}
                    </span>
                  </div>
                  <div className="truncate p-2 text-xs font-medium">
                    {item.shot_type || "Additional photo"}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
        <aside className="ds-surface h-fit p-4 xl:sticky xl:top-20">
          {selected ? (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Selected photo
                </p>
                <p className="mt-1 text-sm font-semibold">
                  #{items.findIndex((item) => item.id === selected.id) + 1} ·{" "}
                  {selected.shot_type || "Unassigned"}
                </p>
              </div>
              {isAdmin && session.status !== "prepared" ? (
                <>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium">
                      Guided shot assignment
                    </label>
                    <ProductSelect
                      value={selected.shot_type ?? ""}
                      onValueChange={(value) =>
                        void updateItem(selected, { shot_type: value || null })
                      }
                      ariaLabel="Shot assignment"
                      emptyLabel="Additional gallery photo"
                      options={SHOT_TYPES.map((shot) => ({ value: shot.name, label: shot.name }))}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      onClick={() => void move(selected, -1)}
                      disabled={items[0]?.id === selected.id}
                    >
                      <ArrowUp className="size-4" />
                      Earlier
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void move(selected, 1)}
                      disabled={items.at(-1)?.id === selected.id}
                    >
                      <ArrowDown className="size-4" />
                      Later
                    </Button>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => void updateItem(selected, { is_main: true })}
                    disabled={selected.is_main}
                  >
                    <Star className="size-4" />
                    Mark Main Image
                  </Button>
                  {session.status === "completed" && (
                    <Button
                      className="w-full"
                      onClick={() => void associate(selected.id)}
                      disabled={associating}
                    >
                      {associating ? "Opening Customize…" : "Customize Selected"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className="w-full text-destructive hover:text-destructive"
                    onClick={() => void remove(selected)}
                  >
                    <Trash2 className="size-4" />
                    Remove Photo
                  </Button>
                  <p className="rounded-md bg-secondary/60 p-3 text-xs leading-5 text-muted-foreground">
                    Customize and Fix Cutout become available in the vehicle workspace immediately
                    after association. Originals are not re-uploaded.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Capture controls remain focused on upload and completion. Office organization is
                  limited to Dealer Admin and Owner.
                </p>
              )}
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Upload className="mx-auto mb-2 size-6" />
              Select a photo
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
