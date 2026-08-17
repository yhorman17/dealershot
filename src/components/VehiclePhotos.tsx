import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Check,
  FileImage,
  ImagePlus,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { EmptyState, ProductSelect, SectionHeader, StatusBadge } from "@/components/product-ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { createUploadQueue, type UploadEntry } from "@/lib/upload-queue";
import { EditorLoading, PhotoEditorBoundary } from "@/components/PhotoEditorBoundary";

const BackgroundEditor = lazy(() =>
  import("@/components/BackgroundEditor").then((module) => ({ default: module.BackgroundEditor })),
);

export const SHOT_TYPES = [
  {
    name: "Front",
    tip: "Stand 10-15 feet away, camera at headlight height, entire front bumper in frame.",
  },
  {
    name: "Rear",
    tip: "Stand 10-15 feet away, camera at taillight height, entire rear bumper in frame.",
  },
  {
    name: "Driver Side",
    tip: "Stand back so the full side profile is in frame, camera at door handle height.",
  },
  {
    name: "Passenger Side",
    tip: "Same as driver side — full side profile, level with door handles.",
  },
  {
    name: "Front 3/4",
    tip: "Stand at the front-driver corner. Capture both front and driver side in one shot.",
  },
  {
    name: "Rear 3/4",
    tip: "Stand at the rear-passenger corner. Capture both rear and passenger side.",
  },
  {
    name: "Dashboard",
    tip: "Open driver door, shoot the dashboard straight on with steering wheel centered.",
  },
  { name: "Seats", tip: "Shoot from the open door showing front and rear seats clearly." },
  {
    name: "Trunk",
    tip: "Open the trunk fully, shoot from a few feet back showing the entire cargo area.",
  },
  {
    name: "Engine",
    tip: "Open the hood and prop it. Shoot from the front showing the full engine bay.",
  },
  {
    name: "Odometer",
    tip: "Turn ignition to ACC, get close to the cluster, mileage clearly readable.",
  },
] as const;

const STANDARD_SHOT_NAMES: Set<string> = new Set(SHOT_TYPES.map((s) => s.name));
type GuidedShot = {
  name: string;
  tip: string;
  category: "exterior" | "interior" | "detail" | "odometer" | "vin";
  required: boolean;
  minimumCount: number;
};

const FALLBACK_GUIDED_SHOTS: GuidedShot[] = SHOT_TYPES.map((shot) => ({
  ...shot,
  category: ["Dashboard", "Seats", "Trunk"].includes(shot.name)
    ? "interior"
    : shot.name === "Odometer"
      ? "odometer"
      : shot.name === "Engine"
        ? "detail"
        : "exterior",
  required: true,
  minimumCount: 1,
}));

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
  original_image_url?: string;
  cutout_image_url?: string | null;
  corrected_cutout_url?: string | null;
  photo_state?: "raw" | "cutout" | "customized";
};

type CaptureUpload = { file: File; shotType: string | null; replacePhotoId?: string };

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

async function deleteStoredPhoto(photo: Photo) {
  try {
    const url = new URL(photo.image_url);
    const index = url.pathname.indexOf("/vehicle-photos/");
    if (index !== -1) {
      const path = url.pathname.slice(index + "/vehicle-photos/".length);
      await supabase.storage.from("vehicle-photos").remove([path]);
    }
  } catch {
    // A malformed legacy URL should not prevent removal of its database row.
  }
  await supabase.from("photos").delete().eq("id", photo.id);
}

type LibraryDoc = { id: string; name: string; image_url: string };

export function VehiclePhotos({
  vehicleId,
  initialCustomizePhotoId,
}: {
  vehicleId: string;
  initialCustomizePhotoId?: string;
}) {
  const { user } = useAuth();
  const userId = user?.id;
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [docLinks, setDocLinks] = useState<VehicleDocument[]>([]);
  const [mode, setMode] = useState<"guided" | "free">("guided");
  const [customLabel, setCustomLabel] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);
  const [dealershipId, setDealershipId] = useState<string | null>(null);
  const [guidedShots, setGuidedShots] = useState<GuidedShot[]>(FALLBACK_GUIDED_SHOTS);
  const [captureStatus, setCaptureStatus] = useState<"idle" | "in_progress" | "completed">("idle");
  const [starting, setStarting] = useState(false);
  const [queueEntries, setQueueEntries] = useState<UploadEntry<CaptureUpload>[]>([]);
  const [completing, setCompleting] = useState(false);
  const captureSessionRef = useRef<string | null>(null);
  const captureContextRef = useRef<{
    vehicleId: string;
    dealershipId: string;
    vin: string | null;
  } | null>(null);
  const captureContextPromiseRef = useRef<Promise<{
    vehicleId: string;
    dealershipId: string;
    vin: string | null;
  }> | null>(null);
  const surfacedUploadFailuresRef = useRef(new Set<string>());
  const photosRef = useRef<Photo[]>([]);
  const nextSortRef = useRef(0);
  const initialCustomizeOpenedRef = useRef(false);
  const [bgPhoto, setBgPhoto] = useState<Photo | null>(null);
  const [showAttachDoc, setShowAttachDoc] = useState(false);
  const [activeShotName, setActiveShotName] = useState<string>("Front");
  const [completionWarning, setCompletionWarning] = useState<{
    sessionId: string;
    missing: Array<{ label: string; category: string }>;
    policy: "block" | "warn";
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Photo | null>(null);
  const [pendingDetach, setPendingDetach] = useState<VehicleDocument | null>(null);

  const getCaptureContext = useCallback(async () => {
    if (captureContextRef.current?.vehicleId === vehicleId) return captureContextRef.current;
    if (captureContextPromiseRef.current) return captureContextPromiseRef.current;

    const request = (async () => {
      const { data, error } = await supabase
        .from("vehicles")
        .select("dealership_id, vin")
        .eq("id", vehicleId)
        .maybeSingle();
      if (error) throw error;
      if (!data?.dealership_id) {
        throw new Error("This vehicle is not connected to an available dealership.");
      }
      const context = {
        vehicleId,
        dealershipId: data.dealership_id as string,
        vin: (data.vin as string | null) || null,
      };
      captureContextRef.current = context;
      setDealershipId(context.dealershipId);
      return context;
    })();
    captureContextPromiseRef.current = request;
    try {
      return await request;
    } finally {
      captureContextPromiseRef.current = null;
    }
  }, [vehicleId]);

  useEffect(() => {
    captureSessionRef.current = null;
    captureContextRef.current = null;
    captureContextPromiseRef.current = null;
    setDealershipId(null);
    void getCaptureContext().catch(() => {
      // Capture remains available: the queued job will retry this lookup and
      // surface an actionable error without dropping the selected File.
    });
  }, [getCaptureContext]);

  useEffect(() => {
    if (!dealershipId) return;
    let cancelled = false;
    void supabase
      .from("photo_shot_requirements")
      .select("label, guidance, category, required, minimum_count")
      .eq("dealership_id", dealershipId)
      .eq("enabled", true)
      .order("sort_order")
      .then(({ data, error }) => {
        if (cancelled || error || !data?.length) return;
        const configured = data.map((shot) => ({
          name: shot.label,
          tip: shot.guidance || "Keep the full subject sharp, level, and clearly in frame.",
          category: shot.category,
          required: shot.required,
          minimumCount: shot.minimum_count,
        }));
        setGuidedShots(configured);
        setActiveShotName((current) =>
          configured.some((shot) => shot.name === current) ? current : configured[0].name,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [dealershipId]);

  const load = useCallback(
    async ({ animate = false }: { animate?: boolean } = {}) => {
      const [{ data: ph }, { data: vd }] = await Promise.all([
        supabase
          .from("photos")
          .select(
            "id, vehicle_id, image_url, shot_type, created_at, sort_order, is_main, is_cutout, cutout_status, original_image_url, cutout_image_url, corrected_cutout_url, photo_state",
          )
          .eq("vehicle_id", vehicleId),
        supabase
          .from("vehicle_documents")
          .select(
            "id, vehicle_id, document_id, sort_order, is_main, created_at, document:documents(id, name, image_url)",
          )
          .eq("vehicle_id", vehicleId),
      ]);
      const commit = () => {
        const nextPhotos = (ph as Photo[]) || [];
        const nextDocuments = (vd as unknown as VehicleDocument[]) || [];
        nextSortRef.current = Math.max(
          nextSortRef.current,
          ...nextPhotos.map((photo) => photo.sort_order + 1),
          ...nextDocuments.map((document) => document.sort_order + 1),
        );
        setPhotos(nextPhotos);
        setDocLinks(nextDocuments);
      };
      const canAnimateLayout =
        animate &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
        "startViewTransition" in document;
      if (canAnimateLayout) {
        document.startViewTransition(commit);
      } else {
        commit();
      }
    },
    [vehicleId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!initialCustomizePhotoId || initialCustomizeOpenedRef.current || photos.length === 0)
      return;
    const requestedPhoto = photos.find((photo) => photo.id === initialCustomizePhotoId);
    initialCustomizeOpenedRef.current = true;
    if (!requestedPhoto) return;
    setBgPhoto(requestedPhoto);
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, [initialCustomizePhotoId, photos]);

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
  photosRef.current = photos;

  const maxSort = () => items.reduce((m, i) => Math.max(m, i.sort_order), -1);

  const ensureCaptureSession = useCallback(async () => {
    if (!userId) throw new Error("Your signed-in session is unavailable. Sign in and try again.");
    if (captureSessionRef.current) return captureSessionRef.current;
    const context = await getCaptureContext();
    const { data: existing } = await supabase
      .from("photo_capture_sessions")
      .select("id, status")
      .eq("vehicle_id", vehicleId)
      .eq("created_by", userId)
      .eq("mode", "guided")
      .eq("status", "in_progress")
      .maybeSingle();
    if (existing?.id) {
      captureSessionRef.current = existing.id;
      setCaptureStatus("in_progress");
      return existing.id;
    }
    const { data, error } = await supabase.rpc("start_photo_capture_session", {
      _dealership_id: context.dealershipId,
      _vehicle_id: vehicleId,
      _vin: context.vin,
      _mode: "guided",
    });
    if (error) {
      const { data: raced } = await supabase
        .from("photo_capture_sessions")
        .select("id")
        .eq("vehicle_id", vehicleId)
        .eq("created_by", userId)
        .eq("mode", "guided")
        .eq("status", "in_progress")
        .maybeSingle();
      if (!raced?.id) throw error;
      captureSessionRef.current = raced.id;
      setCaptureStatus("in_progress");
      return raced.id;
    }
    captureSessionRef.current = data.id;
    setCaptureStatus("in_progress");
    return data.id;
  }, [getCaptureContext, userId, vehicleId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void supabase
      .from("photo_capture_sessions")
      .select("id")
      .eq("vehicle_id", vehicleId)
      .eq("created_by", userId)
      .eq("mode", "guided")
      .eq("status", "in_progress")
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data?.id) return;
        captureSessionRef.current = data.id;
        setCaptureStatus("in_progress");
      });
    return () => {
      cancelled = true;
    };
  }, [userId, vehicleId]);

  const startShoot = async () => {
    if (starting || captureStatus === "in_progress") return;
    setStarting(true);
    try {
      await ensureCaptureSession();
      toast.success("Photo shoot started", {
        description:
          "Raw originals save as you capture. Finish the shoot when the vehicle is done.",
      });
    } catch (reason) {
      toast.error("Photo shoot could not start", {
        description: reason instanceof Error ? reason.message : "Try again.",
      });
    } finally {
      setStarting(false);
    }
  };

  const uploadQueue = useMemo(
    () =>
      createUploadQueue<CaptureUpload>(async ({ file, shotType, replacePhotoId }) => {
        const sessionId = await ensureCaptureSession();
        const extension = file.name.split(".").pop() || "jpg";
        const path = `${vehicleId}/originals/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage
          .from("vehicle-photos")
          .upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });
        if (uploadError) throw uploadError;
        const imageUrl = supabase.storage.from("vehicle-photos").getPublicUrl(path).data.publicUrl;
        const sortOrder = nextSortRef.current;
        nextSortRef.current += 1;
        const { error: photoError } = await supabase.from("photos").insert({
          vehicle_id: vehicleId,
          image_url: imageUrl,
          original_image_url: imageUrl,
          shot_type: shotType,
          sort_order: sortOrder,
          capture_session_id: sessionId,
          photo_state: "raw",
          is_cutout: false,
          cutout_status: "none",
        });
        if (photoError) {
          await supabase.storage.from("vehicle-photos").remove([path]);
          throw photoError;
        }
        if (replacePhotoId) {
          const replaced = photosRef.current.find((photo) => photo.id === replacePhotoId);
          if (replaced) await deleteStoredPhoto(replaced);
        }
        await load({ animate: true });
      }),
    [ensureCaptureSession, load, vehicleId],
  );

  useEffect(() => uploadQueue.subscribe(setQueueEntries), [uploadQueue]);

  useEffect(() => {
    queueEntries.forEach((entry) => {
      if (entry.state !== "failed") return;
      const failureKey = `${entry.id}:${entry.attempts}`;
      if (surfacedUploadFailuresRef.current.has(failureKey)) return;
      surfacedUploadFailuresRef.current.add(failureKey);
      toast.error("Photo upload failed", {
        description: entry.error || "The original is still available. Tap Retry Uploads.",
      });
    });
  }, [queueEntries]);

  const handleGuidedUpload = async (shotName: string, file: File) => {
    setCaptureStatus("in_progress");
    const existing = photos.find((p) => p.shot_type === shotName);
    uploadQueue.add({ file, shotType: shotName, replacePhotoId: existing?.id });
    const currentIndex = guidedShots.findIndex((shot) => shot.name === shotName);
    const next = guidedShots
      .slice(currentIndex + 1)
      .find((shot) => !photos.some((photo) => photo.shot_type === shot.name));
    if (next) setActiveShotName(next.name);
    toast.success(`${shotName} queued`, { description: "You can take the next photo now." });
  };

  const handleFreeUpload = async (files: FileList, shotType: string | null) => {
    setCaptureStatus("in_progress");
    Array.from(files).forEach((file) => uploadQueue.add({ file, shotType }));
  };

  const handleCustomUpload = async (file: File) => {
    const label = customLabel.trim();
    if (!label) return;
    setCaptureStatus("in_progress");
    uploadQueue.add({ file, shotType: label });
    setCustomLabel("");
    setAddingCustom(false);
  };

  const deletePhoto = async (photo: Photo, skipConfirm = false) => {
    await deleteStoredPhoto(photo);
    if (!skipConfirm) {
      await load({ animate: true });
      toast.success("Photo deleted");
    }
  };

  const detachDocument = async (link: VehicleDocument) => {
    await supabase.from("vehicle_documents").delete().eq("id", link.id);
    await load({ animate: true });
    toast.success("Document detached");
  };

  const setAsMain = async (item: GalleryItem) => {
    if (item.is_main) return;
    const assetId = item.kind === "photo" ? item.photo?.id : item.link?.id;
    if (!assetId) return;
    const { error } = await supabase.rpc("set_vehicle_primary_asset", {
      _vehicle_id: vehicleId,
      _asset_type: item.kind,
      _asset_id: assetId,
    });
    if (error) {
      toast.error("Main image could not be changed", { description: error.message });
      return;
    }
    await load({ animate: true });
    toast.success("Main image updated");
  };

  const moveItem = async (item: GalleryItem, direction: -1 | 1) => {
    const orderedNonMain = sortItems(items).filter((i) => !i.is_main);
    const idx = orderedNonMain.findIndex((i) => i.key === item.key);
    const targetIdx = idx + direction;
    if (idx === -1 || targetIdx < 0 || targetIdx >= orderedNonMain.length) return;
    const reordered = [...orderedNonMain];
    [reordered[idx], reordered[targetIdx]] = [reordered[targetIdx], reordered[idx]];
    const completeOrder = [...sortItems(items).filter((entry) => entry.is_main), ...reordered];
    const { error } = await supabase.rpc("reorder_vehicle_gallery", {
      _vehicle_id: vehicleId,
      _items: completeOrder.map((entry, index) => ({
        type: entry.kind,
        id: entry.kind === "photo" ? entry.photo?.id : entry.link?.id,
        position: index + 1,
      })),
    });
    if (error) {
      toast.error("Photo order could not be saved", { description: error.message });
      return;
    }
    await load({ animate: true });
  };

  const attachDocument = async (doc: LibraryDoc) => {
    const { error } = await supabase.from("vehicle_documents").insert({
      vehicle_id: vehicleId,
      document_id: doc.id,
      sort_order: maxSort() + 1,
    });
    if (error) {
      toast.error("Document could not be attached", { description: error.message });
      return;
    }
    setShowAttachDoc(false);
    await load({ animate: true });
  };

  const configuredShotNames = new Set(guidedShots.map((shot) => shot.name));
  const completed = guidedShots.filter((s) => photos.some((p) => p.shot_type === s.name)).length;
  const customShots = photos.filter(
    (p) =>
      p.shot_type && !configuredShotNames.has(p.shot_type) && !STANDARD_SHOT_NAMES.has(p.shot_type),
  );
  const orderedNonMain = sortItems(items).filter((i) => !i.is_main);
  const attachedDocIds = new Set(docLinks.map((l) => l.document_id));
  const activeShot = guidedShots.find((shot) => shot.name === activeShotName) ?? guidedShots[0];
  const activePhoto = photos.find((photo) => photo.shot_type === activeShot.name);
  const requiredShots = guidedShots.filter((shot) => shot.required);
  const missingGuidedShots = requiredShots.filter(
    (shot) => photos.filter((photo) => photo.shot_type === shot.name).length < shot.minimumCount,
  );
  const categoryProgress = (["exterior", "interior"] as const).map((category) => {
    const categoryShots = requiredShots.filter((shot) => shot.category === category);
    return {
      category,
      complete: categoryShots.filter(
        (shot) =>
          photos.filter((photo) => photo.shot_type === shot.name).length >= shot.minimumCount,
      ).length,
      total: categoryShots.length,
    };
  });
  const pendingUploads = queueEntries.filter(
    (entry) => entry.state === "queued" || entry.state === "uploading",
  ).length;
  const failedUploads = queueEntries.filter((entry) => entry.state === "failed").length;
  const registeredPhotoCount = photos.length + pendingUploads + failedUploads;
  const latestUploadError = [...queueEntries]
    .reverse()
    .find((entry) => entry.state === "failed")?.error;

  const finalizePhotos = async (sessionId: string) => {
    const { error } = await supabase.rpc("complete_photo_capture_session", {
      _session_id: sessionId,
    });
    if (error) throw error;
    setCaptureStatus("completed");
    captureSessionRef.current = null;
    setCompletionWarning(null);
    toast.success("Vehicle photos completed", {
      description: `${photos.length} photo${photos.length === 1 ? "" : "s"} captured.`,
    });
  };

  const completePhotos = async () => {
    setCompleting(true);
    await uploadQueue.waitForIdle();
    const failures = uploadQueue.getSnapshot().filter((entry) => entry.state === "failed").length;
    if (failures > 0) {
      toast.error(`${failures} photo${failures === 1 ? "" : "s"} still need to upload`, {
        description: "Retry failed uploads before completing this vehicle.",
      });
      setCompleting(false);
      return;
    }
    try {
      const sessionId = await ensureCaptureSession();
      const { data, error: completenessError } = await supabase.rpc(
        "get_capture_session_completeness",
        { _session_id: sessionId },
      );
      if (completenessError) throw completenessError;
      const result = (data ?? {}) as {
        completion_policy?: "block" | "warn";
        missing?: Array<{ label: string; category: string }>;
      };
      const missing = Array.isArray(result.missing) ? result.missing : [];
      if (missing.length > 0) {
        setCompletionWarning({ sessionId, missing, policy: result.completion_policy ?? "warn" });
        setCompleting(false);
        return;
      }
      await finalizePhotos(sessionId);
    } catch (reason) {
      toast.error("Photos could not be completed", {
        description: reason instanceof Error ? reason.message : "Try again.",
      });
    } finally {
      setCompleting(false);
    }
  };

  return (
    <div className="ds-surface overflow-hidden">
      <div className="flex border-b border-border bg-secondary/35 p-1">
        {(["guided", "free"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`motion-tab flex min-h-10 flex-1 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold ${
              mode === m
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {m === "guided" ? (
              <>
                <Camera className="size-4" />
                Guided capture
              </>
            ) : (
              <>
                <Upload className="size-4" />
                Free upload
              </>
            )}
          </button>
        ))}
      </div>

      <div className="border-b border-border p-4 sm:p-5">
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
          <div aria-live="polite">
            <p className="text-sm font-semibold">{registeredPhotoCount} photos registered</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {failedUploads > 0
                ? `${failedUploads} failed — ${latestUploadError || "tap retry before completing"}`
                : pendingUploads > 0
                  ? `${pendingUploads} safely queued or uploading while you continue`
                  : captureStatus === "completed"
                    ? "Vehicle photos completed"
                    : captureStatus === "in_progress"
                      ? photos.length > 0
                        ? "All raw originals are safely uploaded"
                        : "Shoot in progress — capture the first photo"
                      : photos.length > 0
                        ? "All raw originals are safely uploaded"
                        : "Start a shoot when you are ready to photograph this vehicle"}
            </p>
          </div>
          <div className="flex gap-2">
            {failedUploads > 0 && (
              <Button variant="outline" onClick={() => uploadQueue.retryFailed()}>
                <RefreshCw className="size-4" /> Retry Uploads
              </Button>
            )}
            {captureStatus === "in_progress" ? (
              <Button
                className="min-h-12 flex-1 sm:flex-none"
                onClick={() => void completePhotos()}
                disabled={completing || registeredPhotoCount === 0}
              >
                <Check className="size-4" />
                {completing ? "Completing…" : "Complete Photos"}
              </Button>
            ) : (
              <Button
                className="min-h-12 flex-1 sm:flex-none"
                onClick={() => void startShoot()}
                disabled={starting}
              >
                <Camera className="size-4" />
                {starting ? "Starting…" : "Start Shoot"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {mode === "guided" ? (
        <div key="guided" className="motion-content">
          <div className="border-b border-border p-4 sm:p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Guided photo set</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Move through the standard angles without leaving this view.
                </p>
              </div>
              <StatusBadge tone={completed === guidedShots.length ? "success" : "info"}>
                {completed} / {guidedShots.length} complete
              </StatusBadge>
            </div>
            <Progress
              value={guidedShots.length ? (completed / guidedShots.length) * 100 : 0}
              className="mt-4 h-1.5"
              aria-label={`${completed} of ${guidedShots.length} guided shots complete`}
            />
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {categoryProgress.map((progress) => (
                <div
                  key={progress.category}
                  className="rounded-md border border-border bg-secondary/35 px-3 py-2 text-xs"
                >
                  <span className="font-semibold">
                    {progress.category === "exterior" ? "Exterior" : "Interior"}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    {progress.total
                      ? `${progress.complete} / ${progress.total}`
                      : "No required shots"}
                  </span>
                </div>
              ))}
            </div>
            {missingGuidedShots.length > 0 ? (
              <div
                className="mt-3 rounded-md border border-warning/35 bg-warning/10 p-3 text-xs text-warning-foreground"
                aria-live="polite"
              >
                <p className="font-semibold">
                  {missingGuidedShots.length} required shot
                  {missingGuidedShots.length === 1 ? "" : "s"} remaining
                </p>
                <p className="mt-1">
                  Missing: {missingGuidedShots.map((shot) => shot.name).join(", ")}
                </p>
              </div>
            ) : requiredShots.length > 0 ? (
              <div className="mt-3 flex items-center gap-2 rounded-md border border-success/25 bg-success/10 p-3 text-xs text-success">
                <Check className="size-4" /> All required shots are captured.
              </div>
            ) : null}
          </div>

          <div className="grid lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
            <div className="relative min-h-[19rem] bg-[color:oklch(0.2_0.025_252)] sm:min-h-[28rem]">
              {activePhoto ? (
                <img
                  src={activePhoto.image_url}
                  alt={activeShot.name}
                  className="absolute inset-0 h-full w-full object-contain"
                />
              ) : (
                <div className="ds-grid-lines absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/45">
                  <Camera className="size-9" />
                  <p className="text-sm font-medium">Ready for {activeShot.name.toLowerCase()}</p>
                </div>
              )}
              <div className="absolute left-3 top-3">
                <StatusBadge tone={activePhoto ? "success" : "neutral"}>
                  {activePhoto ? "Captured" : "Pending"}
                </StatusBadge>
              </div>
            </div>
            <div className="flex flex-col p-5 sm:p-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                Current shot
              </p>
              <h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">
                {activeShot.name}
              </h3>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{activeShot.tip}</p>
              <div className="mt-5 rounded-md border border-border bg-secondary/50 p-3 text-xs leading-5 text-muted-foreground">
                <strong className="text-foreground">Fast workflow:</strong> capture once, review the
                preview, then DealerShot advances to the next unfinished angle.
              </div>
              <label className="motion-upload-target mt-auto flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
                {activePhoto ? (
                  <>
                    <RefreshCw className="size-4" />
                    Replace {activeShot.name}
                  </>
                ) : (
                  <>
                    <Camera className="size-5" />
                    Capture {activeShot.name}
                  </>
                )}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleGuidedUpload(activeShot.name, file);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>

          <div className="border-t border-border p-4 sm:p-5">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Shot sequence
            </p>
            <div
              className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6"
              role="list"
              aria-label="Guided shot sequence"
            >
              {guidedShots.map((shot, index) => {
                const taken = photos.find((photo) => photo.shot_type === shot.name);
                const active = activeShot.name === shot.name;
                return (
                  <button
                    type="button"
                    key={shot.name}
                    onClick={() => setActiveShotName(shot.name)}
                    className={`motion-row min-w-0 rounded-md border p-2 text-left ${active ? "border-primary bg-selected" : "border-border bg-card hover:bg-secondary/60"}`}
                    aria-pressed={active}
                  >
                    <div className="relative mb-2 aspect-[4/3] overflow-hidden rounded bg-secondary">
                      {taken ? (
                        <img src={taken.image_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-muted-foreground">
                          <span className="text-xs font-semibold tabular-nums">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                        </div>
                      )}
                      {taken && (
                        <span className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-success text-success-foreground">
                          <Check className="size-3" />
                        </span>
                      )}
                    </div>
                    <span className="block truncate text-[11px] font-semibold text-foreground">
                      {shot.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-card-foreground">
                  Custom shots & documents
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Add details outside the standard sequence.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{customShots.length} custom</span>
            </div>

            {customShots.length > 0 && (
              <ul className="mb-3 grid gap-2 sm:grid-cols-2">
                {customShots.map((p) => (
                  <li
                    key={p.id}
                    className="motion-content flex items-center gap-3 rounded-md border border-border bg-card p-2"
                  >
                    <div className="flex-shrink-0 w-12 h-12 rounded overflow-hidden bg-background">
                      <img
                        src={p.image_url}
                        alt={p.shot_type || ""}
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <span className="flex-1 text-sm text-card-foreground truncate">
                      {p.shot_type}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {addingCustom ? (
              <div className="motion-content space-y-2 p-3 rounded-md border border-border bg-background">
                <label className="block text-xs font-medium text-card-foreground">
                  Custom shot label
                </label>
                <Input
                  type="text"
                  value={customLabel}
                  onChange={(e) => setCustomLabel(e.target.value)}
                  placeholder="e.g. Window Sticker, Sunroof, Damage - rear bumper"
                  className="h-11"
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
                    Capture / Upload
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      disabled={!customLabel.trim()}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleCustomUpload(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setAddingCustom(false);
                      setCustomLabel("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddingCustom(true)}
                className="motion-upload-target w-full border-dashed"
              >
                <Plus className="size-4" />
                Add custom shot
              </Button>
            )}

            <Button
              type="button"
              variant="outline"
              onClick={() => setShowAttachDoc(true)}
              className="motion-upload-target mt-2 w-full border-dashed"
            >
              <FileImage className="size-4" />
              Attach document from library
            </Button>
          </div>
        </div>
      ) : (
        <FreeUploadPanel
          onUpload={handleFreeUpload}
          onAttachDocument={() => setShowAttachDoc(true)}
        />
      )}

      {/* Gallery */}
      <div className="border-t border-border">
        <SectionHeader
          title={`Gallery · ${items.length}`}
          description="Raw originals upload first. Office users can prepare each photo later in Customize."
        />
        <div className="p-4 sm:p-5">
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <p className="hidden text-xs text-muted-foreground md:block">
              Main image stays pinned first; office controls change the remaining order.
            </p>
          </div>
          {items.length === 0 ? (
            <EmptyState
              compact
              icon={<ImagePlus className="size-5" />}
              title="No photos in this workspace"
              description="Use guided capture for the standard set or free upload for existing photos."
            />
          ) : (
            <div className="motion-content grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {sortItems(items).map((it) => {
                const nonMainIdx = it.is_main
                  ? -1
                  : orderedNonMain.findIndex((x) => x.key === it.key);
                const canMoveUp = !it.is_main && nonMainIdx > 0;
                const canMoveDown =
                  !it.is_main && nonMainIdx !== -1 && nonMainIdx < orderedNonMain.length - 1;
                const isDoc = it.kind === "document";
                const photo = it.photo;
                const isCutout = !!photo?.is_cutout;
                const photoState =
                  photo?.photo_state === "customized"
                    ? "Customized"
                    : photo?.photo_state === "cutout" || isCutout
                      ? "Cutout Ready"
                      : "Raw";
                return (
                  <div
                    key={it.key}
                    className={`motion-gallery-item group relative rounded-md overflow-hidden bg-background ${it.is_main ? "ring-2 ring-primary" : ""}`}
                    style={{
                      viewTransitionName: `ds-gallery-${it.key.replace(/[^a-zA-Z0-9-]/g, "-")}`,
                    }}
                  >
                    <div
                      className="aspect-square relative"
                      style={
                        isCutout
                          ? {
                              backgroundImage:
                                "linear-gradient(45deg, rgba(255,255,255,0.04) 25%, transparent 25%), linear-gradient(-45deg, rgba(255,255,255,0.04) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.04) 75%), linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.04) 75%)",
                              backgroundSize: "16px 16px",
                              backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
                            }
                          : undefined
                      }
                    >
                      <img
                        src={it.image_url}
                        alt={it.label}
                        className="w-full h-full object-contain"
                      />

                      {it.label && (
                        <span className="absolute top-1.5 left-1.5 inline-flex items-center rounded bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-medium text-white max-w-[80%] truncate">
                          {it.label}
                        </span>
                      )}

                      <div className="absolute top-1.5 right-1.5 flex flex-col items-end gap-1">
                        {it.is_main && (
                          <span className="motion-status inline-flex items-center rounded bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white">
                            MAIN
                          </span>
                        )}
                        {isDoc && (
                          <span className="motion-status inline-flex items-center rounded bg-primary/90 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-primary-foreground">
                            DOCUMENT
                          </span>
                        )}
                        {!isDoc && (
                          <span className="motion-status inline-flex items-center rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">
                            {photoState}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 p-2 bg-background border-t border-border">
                      {!it.is_main && (
                        <div className="hidden items-center gap-1 md:flex">
                          <Button
                            type="button"
                            variant="secondary"
                            size="icon"
                            onClick={() => void moveItem(it, -1)}
                            disabled={!canMoveUp}
                            aria-label="Move earlier"
                            className="size-11"
                          >
                            <ArrowUp className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="icon"
                            onClick={() => void moveItem(it, 1)}
                            disabled={!canMoveDown}
                            aria-label="Move later"
                            className="size-11"
                          >
                            <ArrowDown className="size-4" />
                          </Button>
                        </div>
                      )}
                      <div className="flex flex-wrap items-stretch gap-1.5">
                        {!isDoc && dealershipId && it.photo && (
                          <button
                            onClick={() => setBgPhoto(it.photo!)}
                            className="hidden min-h-[44px] min-w-[6.5rem] flex-1 rounded bg-secondary px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-secondary/80 md:block"
                          >
                            Customize
                          </button>
                        )}
                        {!it.is_main && (
                          <button
                            onClick={() => void setAsMain(it)}
                            className="hidden min-h-[44px] min-w-[6.5rem] flex-1 rounded bg-secondary px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-secondary/80 md:block"
                          >
                            Set as main
                          </button>
                        )}
                        {isDoc ? (
                          <button
                            onClick={() => setPendingDetach(it.link!)}
                            className="flex-1 min-w-[6.5rem] min-h-[44px] rounded border border-border bg-secondary px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-secondary/80"
                          >
                            Detach
                          </button>
                        ) : (
                          <button
                            onClick={() => setPendingDelete(it.photo!)}
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
      </div>

      {bgPhoto && dealershipId && (
        <PhotoEditorBoundary onClose={() => setBgPhoto(null)}>
          <Suspense fallback={<EditorLoading onClose={() => setBgPhoto(null)} />}>
            <BackgroundEditor
              photo={bgPhoto}
              dealershipId={dealershipId}
              onClose={() => setBgPhoto(null)}
              onSaved={() => {
                setBgPhoto(null);
                void load({ animate: true });
              }}
            />
          </Suspense>
        </PhotoEditorBoundary>
      )}

      {showAttachDoc && dealershipId && (
        <PickDocumentModal
          dealershipId={dealershipId}
          alreadyAttached={attachedDocIds}
          onClose={() => setShowAttachDoc(false)}
          onPick={(d) => void attachDocument(d)}
        />
      )}
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this photo?</AlertDialogTitle>
            <AlertDialogDescription>
              The image will be removed from this vehicle and from storage. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep photo</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) void deletePhoto(pendingDelete);
                setPendingDelete(null);
              }}
            >
              <Trash2 className="size-4" />
              Delete photo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!completionWarning}
        onOpenChange={(open) => !open && setCompletionWarning(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Required shots are still missing</AlertDialogTitle>
            <AlertDialogDescription>
              {completionWarning?.policy === "block"
                ? "This store requires the missing shots before this shoot can be completed."
                : "This store allows completion with a warning, but the vehicle will remain a short shoot until these shots are added."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 list-disc overflow-y-auto pl-5 text-sm text-muted-foreground">
            {completionWarning?.missing.map((item, index) => (
              <li key={`${item.label}-${index}`}>
                {item.label} · {item.category}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep shooting</AlertDialogCancel>
            {completionWarning?.policy === "warn" ? (
              <AlertDialogAction
                onClick={() => {
                  if (!completionWarning) return;
                  setCompleting(true);
                  void finalizePhotos(completionWarning.sessionId)
                    .catch((reason: unknown) =>
                      toast.error("Photos could not be completed", {
                        description: reason instanceof Error ? reason.message : "Try again.",
                      }),
                    )
                    .finally(() => setCompleting(false));
                }}
              >
                Complete with missing shots
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!pendingDetach} onOpenChange={(open) => !open && setPendingDetach(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Detach this document?</AlertDialogTitle>
            <AlertDialogDescription>
              The document stays in your dealership library, but it will no longer appear with this
              vehicle.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep attached</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDetach) void detachDocument(pendingDetach);
                setPendingDetach(null);
              }}
            >
              Detach document
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FreeUploadPanel({
  onUpload,
  onAttachDocument,
}: {
  onUpload: (files: FileList, shotType: string | null) => Promise<void>;
  onAttachDocument: () => void;
}) {
  const [shotType, setShotType] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div key="free" className="motion-content p-4 sm:p-6">
      <div className="mb-5">
        <h3 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
          Upload existing photos
        </h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Select several files at once or use your phone camera. Uploads appear in the gallery
          without blocking the workspace.
        </p>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-card-foreground mb-1.5">
            Tag with shot type (optional)
          </label>
          <ProductSelect
            value={shotType}
            onValueChange={setShotType}
            ariaLabel="Shot type"
            emptyLabel="No tag"
            options={SHOT_TYPES.map((shot) => ({ value: shot.name, label: shot.name }))}
          />
        </div>
      </div>
      <label className="motion-upload-target ds-grid-lines flex min-h-56 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-input bg-secondary/30 p-8 text-center hover:border-primary/60 hover:bg-selected/35">
        <span className="mb-4 grid size-12 place-items-center rounded-lg border border-border bg-card text-primary shadow-sm">
          <Upload className="size-5" />
        </span>
        <p className="text-sm font-semibold text-card-foreground">Take photos or choose files</p>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
          JPG, PNG, or HEIC from your device · multiple files supported
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0)
              void onUpload(e.target.files, shotType || null);
            e.target.value = "";
          }}
        />
      </label>
      <Button
        type="button"
        variant="outline"
        onClick={onAttachDocument}
        className="motion-upload-target mt-3 w-full border-dashed"
      >
        <FileImage className="size-4" />
        Attach document from library
      </Button>
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Attach a document</DialogTitle>
          <DialogDescription>
            Choose a dealership document to include in this vehicle’s gallery and export order.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3" aria-busy="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="aspect-[4/3] animate-pulse rounded-md bg-secondary" />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <EmptyState
            compact
            icon={<FileImage className="size-5" />}
            title="No documents in the library"
            description="Add a document from the Documents page, then return here to attach it."
          />
        ) : (
          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
            {docs.map((d) => {
              const attached = alreadyAttached.has(d.id);
              return (
                <button
                  key={d.id}
                  disabled={attached}
                  onClick={() => onPick(d)}
                  className={`motion-card text-left rounded-lg border border-border bg-background overflow-hidden hover:border-primary ${attached ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <div className="aspect-[16/9] bg-secondary flex items-center justify-center">
                    <img
                      src={d.image_url}
                      alt={d.name}
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                  <div className="p-3">
                    <p className="text-sm font-medium text-card-foreground truncate">{d.name}</p>
                    {attached && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">Already attached</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
