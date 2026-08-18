import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  Check,
  CheckCircle2,
  ImagePlus,
  RefreshCw,
  RotateCcw,
  Star,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { BulkCamera } from "@/components/BulkCamera";
import { SHOT_TYPES } from "@/components/VehiclePhotos";
import { PageHeader, ProductSelect, StatusBadge } from "@/components/product-ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { supabase } from "@/integrations/supabase/client";
import { createUploadQueue, type UploadEntry } from "@/lib/upload-queue";
import {
  archivePrivateMedia,
  resolveAuthorizedMediaUrls,
  uploadPrivateOriginal,
} from "@/lib/private-media";

export const Route = createFileRoute("/_authenticated/bulk-photos/$id")({
  head: () => ({ meta: [{ title: "Bulk Capture — DealerShot" }] }),
  component: BulkCaptureWorkspace,
});

type Session = {
  id: string;
  dealership_id: string;
  vehicle_id: string | null;
  vin: string | null;
  status: "in_progress" | "completed" | "prepared" | "canceled";
  workflow_stage: "capture" | "review" | "processing" | "completed";
  created_by: string | null;
  started_at: string;
  capture_ended_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  retake_count: number;
};

type Item = {
  id: string;
  session_id: string;
  image_url: string;
  media_asset_id: string;
  storage_path: string;
  shot_type: string | null;
  media_category: string;
  sort_order: number;
  is_main: boolean;
  photo_id: string | null;
  created_at: string;
};

type BulkUpload = { file: File; replaceItemId?: string };

function BulkCaptureWorkspace() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { setSelectedDealershipId } = useAccessibleDealerships();
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedForProcessing, setSelectedForProcessing] = useState<Set<string>>(new Set());
  const [queueEntries, setQueueEntries] = useState<UploadEntry<BulkUpload>[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [replaceItemId, setReplaceItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const nextSortRef = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const itemsRef = useRef<Item[]>([]);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

  const load = useCallback(async () => {
    const [{ data: sessionData, error: sessionError }, { data: itemData, error: itemError }] =
      await Promise.all([
        supabase
          .from("photo_capture_sessions")
          .select(
            "id, dealership_id, vehicle_id, vin, status, workflow_stage, created_by, started_at, capture_ended_at, completed_at, duration_seconds, retake_count",
          )
          .eq("id", id)
          .maybeSingle(),
        supabase
          .from("bulk_photo_items")
          .select(
            "id, session_id, image_url, media_asset_id, storage_path, shot_type, sort_order, is_main, photo_id, created_at",
          )
          .eq("session_id", id)
          .order("sort_order")
          .order("created_at"),
      ]);
    if (sessionError || itemError || !sessionData) {
      setError("This Bulk Capture session is unavailable or outside your store access.");
      return;
    }
    const rawItems = (itemData ?? []) as Omit<Item, "media_category">[];
    const photoIds = rawItems
      .map((item) => item.photo_id)
      .filter((value): value is string => !!value);
    const { data: photoRows } = photoIds.length
      ? await supabase.from("photos").select("id, media_category").in("id", photoIds)
      : { data: [] };
    const categories = new Map((photoRows ?? []).map((photo) => [photo.id, photo.media_category]));
    const urls = await resolveAuthorizedMediaUrls(
      rawItems.map((item) => item.media_asset_id),
      "thumbnail",
    );
    const nextItems = rawItems.map((item) => ({
      ...item,
      media_category:
        (item.photo_id && categories.get(item.photo_id)) || classifyShot(item.shot_type),
      image_url: urls.get(item.media_asset_id) ?? "",
    }));
    const nextSession = sessionData as Session;
    if (nextSession.status === "canceled") {
      setSession(nextSession);
      setItems([]);
      setError("This Bulk Capture workflow was canceled and can no longer be resumed.");
      return;
    }
    sessionRef.current = nextSession;
    itemsRef.current = nextItems;
    setSession(nextSession);
    setItems(nextItems);
    setSelectedId((current) =>
      current && nextItems.some((item) => item.id === current)
        ? current
        : (nextItems[0]?.id ?? null),
    );
    nextSortRef.current = Math.max(0, ...nextItems.map((item) => item.sort_order + 1));
    setSelectedDealershipId(nextSession.dealership_id);
    setError(null);
  }, [id, setSelectedDealershipId]);

  loadRef.current = load;
  useEffect(() => void load(), [load]);

  const uploadQueueRef = useRef<ReturnType<typeof createUploadQueue<BulkUpload>> | null>(null);
  if (!uploadQueueRef.current) {
    uploadQueueRef.current = createUploadQueue<BulkUpload>(
      async ({ file, replaceItemId: replacementId }) => {
        const activeSession = sessionRef.current;
        if (!activeSession || activeSession.status !== "in_progress") {
          throw new Error("This capture session is no longer accepting photos.");
        }
        const replaced = replacementId
          ? itemsRef.current.find((item) => item.id === replacementId)
          : undefined;
        const sortOrder = replaced?.sort_order ?? nextSortRef.current++;
        await uploadPrivateOriginal({
          file,
          bulkSessionId: activeSession.id,
          sortOrder,
        });
        if (replaced) await archivePrivateMedia(replaced.media_asset_id);
        await loadRef.current();
      },
      { concurrency: 2 },
    );
  }
  const uploadQueue = uploadQueueRef.current;
  useEffect(() => uploadQueue.subscribe(setQueueEntries), [uploadQueue]);

  const pending = queueEntries.filter(
    (entry) => entry.state === "queued" || entry.state === "uploading",
  ).length;
  const failed = queueEntries.filter((entry) => entry.state === "failed").length;
  const failedUploads = queueEntries.filter((entry) => entry.state === "failed");
  const visibleCameraUploads = queueEntries
    .filter((entry) => entry.state !== "uploaded")
    .map((entry) => ({
      id: entry.id,
      filename: entry.payload?.file.name ?? "Vehicle photo",
      state: entry.state as "queued" | "uploading" | "failed",
    }));
  const acceptedCount = items.length + pending + failed;
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const workflowStage = session?.workflow_stage;

  useEffect(() => {
    if (!session) return;
    const update = () => {
      const end = session.capture_ended_at ? Date.parse(session.capture_ended_at) : Date.now();
      setElapsedSeconds(Math.max(0, Math.floor((end - Date.parse(session.started_at)) / 1000)));
    };
    update();
    if (session.capture_ended_at) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (workflowStage !== "capture") return;
    setCameraOpen(true);
  }, [session?.id, workflowStage]);

  useEffect(() => {
    const active = workflowStage === "capture" || pending > 0;
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending, workflowStage]);

  const addCapture = (file: File) => {
    const replacementId = replaceItemId ?? undefined;
    uploadQueue.add({ file, replaceItemId: replacementId });
    if (replacementId) {
      setCameraOpen(false);
      setReplaceItemId(null);
      toast.message("Replacement uploading", {
        description: "You can keep reviewing the other photos while it finishes.",
      });
    }
  };

  const finishTakingPhotos = async () => {
    if (!session || busy) return;
    setBusy("finish");
    setCameraOpen(false);
    const { error: endError } = await supabase.rpc("mark_bulk_capture_ended", {
      _session_id: session.id,
    });
    if (endError) {
      toast.error("Photo capture could not finish", { description: endError.message });
      setBusy(null);
      return;
    }
    await uploadQueue.waitForIdle();
    if (uploadQueue.getSnapshot().some((entry) => entry.state === "failed")) {
      toast.error("Some photos still need attention", {
        description: "Retry failed uploads before continuing from Review.",
      });
    }
    await load();
    setBusy(null);
  };

  const remove = async (item: Item) => {
    setBusy(`remove:${item.id}`);
    try {
      await archivePrivateMedia(item.media_asset_id);
      await load();
      toast.success("Photo removed from this vehicle");
    } catch (reason) {
      toast.error("Photo could not be removed", {
        description: reason instanceof Error ? reason.message : "Try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const updateClassification = async (item: Item, shotType: string | null) => {
    const { error: updateError } = await supabase
      .from("bulk_photo_items")
      .update({ shot_type: shotType })
      .eq("id", item.id);
    if (updateError) toast.error("Photo label could not be saved");
    else await load();
  };

  const setMain = async (item: Item) => {
    const { error: updateError } = await supabase.rpc("set_bulk_primary_item", {
      _session_id: id,
      _item_id: item.id,
    });
    if (updateError) toast.error("Main image could not be changed");
    else await load();
  };

  const move = async (item: Item, direction: -1 | 1) => {
    const index = items.findIndex((candidate) => candidate.id === item.id);
    if (!items[index + direction]) return;
    const next = [...items];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    const { error: reorderError } = await supabase.rpc("reorder_bulk_photo_items", {
      _session_id: id,
      _item_ids: next.map((candidate) => candidate.id),
    });
    if (reorderError) toast.error("Photo order changed. Reload and try again.");
    else await load();
  };

  const continueToProcessing = async () => {
    if (!session?.vehicle_id || busy || pending > 0 || failed > 0) return;
    setBusy("next");
    try {
      const { error: completeError } = await supabase.rpc("complete_photo_capture_session", {
        _session_id: session.id,
      });
      if (completeError) throw completeError;
      const { error: associateError } = await supabase.rpc("associate_bulk_photo_session", {
        _session_id: session.id,
        _vehicle_id: session.vehicle_id,
      });
      if (associateError) throw associateError;
      await load();
    } catch (reason) {
      toast.error("Review could not be completed", {
        description: reason instanceof Error ? reason.message : "Try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const finishWorkflow = async () => {
    if (!session || busy) return;
    setBusy("processing");
    try {
      const selectedIds = [...selectedForProcessing];
      const { data: queued, error: queueError } = await supabase.rpc(
        "queue_bulk_background_removal",
        { _session_id: session.id, _item_ids: selectedIds },
      );
      if (queueError) throw queueError;
      const { error: finishError } = await supabase.rpc("complete_bulk_capture_workflow", {
        _session_id: session.id,
      });
      if (finishError) throw finishError;
      toast.success("Vehicle capture complete", {
        description: queued
          ? `${queued} background-removal ${queued === 1 ? "job" : "jobs"} queued. You can continue immediately.`
          : "No background processing was queued.",
      });
      await load();
    } catch (reason) {
      toast.error("Capture workflow could not finish", {
        description: reason instanceof Error ? reason.message : "Try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <main className="ds-page-gutter">
        <div className="ds-surface p-8 text-center text-sm text-destructive">{error}</div>
      </main>
    );
  }
  if (!session) {
    return (
      <main className="ds-page-gutter">
        <div className="ds-surface p-8 text-center text-sm text-muted-foreground" aria-busy>
          Loading capture workflow…
        </div>
      </main>
    );
  }

  return (
    <main className="ds-page-gutter">
      <Button asChild variant="ghost" className="mb-3 -ml-3">
        <Link to="/bulk-photos">
          <ArrowLeft className="size-4" /> Capture
        </Link>
      </Button>
      <PageHeader
        eyebrow={`Bulk Capture · ${stageLabel(session.workflow_stage)}`}
        title={session.vin ?? "Vehicle photos"}
        description={`${acceptedCount} captured · ${formatElapsed(elapsedSeconds)} photo time`}
        actions={
          <StatusBadge tone={session.workflow_stage === "completed" ? "success" : "info"}>
            {session.workflow_stage === "completed"
              ? "Complete"
              : stageLabel(session.workflow_stage)}
          </StatusBadge>
        }
      />

      {session.workflow_stage === "capture" && (
        <CaptureStage
          items={items}
          acceptedCount={acceptedCount}
          pending={pending}
          failed={failed}
          failedUploads={failedUploads}
          busy={busy}
          onOpenCamera={() => setCameraOpen(true)}
          onRetry={() => uploadQueue.retryFailed()}
          onRetryUpload={(entryId) => uploadQueue.retry(entryId)}
          onFinish={() => void finishTakingPhotos()}
        />
      )}

      {session.workflow_stage === "review" && (
        <ReviewStage
          items={items}
          selected={selected}
          selectedId={selectedId}
          pending={pending}
          failed={failed}
          failedUploads={failedUploads}
          busy={busy}
          onSelect={setSelectedId}
          onAddMore={() => setCameraOpen(true)}
          onRetry={() => uploadQueue.retryFailed()}
          onRetryUpload={(entryId) => uploadQueue.retry(entryId)}
          onRetake={(item) => {
            setReplaceItemId(item.id);
            setCameraOpen(true);
          }}
          onRemove={(item) => void remove(item)}
          onClassify={(item, value) => void updateClassification(item, value)}
          onSetMain={(item) => void setMain(item)}
          onMove={(item, direction) => void move(item, direction)}
          onNext={() => void continueToProcessing()}
          hasVehicle={Boolean(session.vehicle_id)}
        />
      )}

      {session.workflow_stage === "processing" && (
        <ProcessingStage
          items={items}
          selected={selectedForProcessing}
          busy={busy}
          onChange={setSelectedForProcessing}
          onDone={() => void finishWorkflow()}
        />
      )}

      {session.workflow_stage === "completed" && (
        <CompletionStage
          photoCount={items.length}
          vehicleId={session.vehicle_id}
          onAnother={() => navigate({ to: "/vehicles/new", search: { dealership: undefined } })}
          onDashboard={() => navigate({ to: "/dashboard" })}
        />
      )}

      {cameraOpen && (
        <BulkCamera
          capturedCount={acceptedCount}
          uploadingCount={pending}
          failedCount={failed}
          uploads={visibleCameraUploads}
          onRetryUpload={(entryId) => uploadQueue.retry(entryId)}
          doneLabel={replaceItemId ? "Cancel retake" : "Finish photos"}
          onCapture={addCapture}
          onDone={() => {
            if (replaceItemId) {
              setReplaceItemId(null);
              setCameraOpen(false);
              return;
            }
            void finishTakingPhotos();
          }}
        />
      )}
    </main>
  );
}

function CaptureStage({
  items,
  acceptedCount,
  pending,
  failed,
  failedUploads,
  busy,
  onOpenCamera,
  onRetry,
  onRetryUpload,
  onFinish,
}: {
  items: Item[];
  acceptedCount: number;
  pending: number;
  failed: number;
  failedUploads: UploadEntry<BulkUpload>[];
  busy: string | null;
  onOpenCamera: () => void;
  onRetry: () => void;
  onRetryUpload: (entryId: string) => void;
  onFinish: () => void;
}) {
  return (
    <section className="ds-surface p-4 sm:p-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <h2 className="text-lg font-semibold">Take photos consecutively</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The camera stays ready while private originals upload two at a time.
          </p>
          <p className="mt-3 text-sm font-semibold" aria-live="polite">
            {acceptedCount} captured · {items.length} uploaded
            {pending ? ` · ${pending} uploading` : ""}
            {failed ? ` · ${failed} failed` : ""}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {failed > 1 && (
            <Button variant="outline" onClick={onRetry}>
              <RefreshCw className="size-4" /> Retry all failed
            </Button>
          )}
          <Button className="min-h-12" onClick={onOpenCamera}>
            <Camera className="size-4" /> Open camera
          </Button>
          <Button
            className="min-h-12"
            variant="outline"
            onClick={onFinish}
            disabled={busy !== null || acceptedCount === 0}
          >
            <Check className="size-4" /> {busy === "finish" ? "Finishing…" : "Finish photos"}
          </Button>
        </div>
      </div>
      <FailedUploadList entries={failedUploads} onRetry={onRetryUpload} />
      <ThumbnailStrip items={items} />
    </section>
  );
}

function ReviewStage({
  items,
  selected,
  selectedId,
  pending,
  failed,
  failedUploads,
  busy,
  onSelect,
  onAddMore,
  onRetry,
  onRetryUpload,
  onRetake,
  onRemove,
  onClassify,
  onSetMain,
  onMove,
  onNext,
  hasVehicle,
}: {
  items: Item[];
  selected: Item | null;
  selectedId: string | null;
  pending: number;
  failed: number;
  failedUploads: UploadEntry<BulkUpload>[];
  busy: string | null;
  onSelect: (id: string) => void;
  onAddMore: () => void;
  onRetry: () => void;
  onRetryUpload: (entryId: string) => void;
  onRetake: (item: Item) => void;
  onRemove: (item: Item) => void;
  onClassify: (item: Item, value: string | null) => void;
  onSetMain: (item: Item) => void;
  onMove: (item: Item, direction: -1 | 1) => void;
  onNext: () => void;
  hasVehicle: boolean;
}) {
  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Review photos</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Remove accidents or retake a selected photo without restarting the vehicle.
            </p>
          </div>
          <Button variant="outline" onClick={onAddMore}>
            <ImagePlus className="size-4" /> Add more
          </Button>
        </div>
        {failed > 1 && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>{failed} uploads failed. Successful photos are still safe.</span>
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry all
            </Button>
          </div>
        )}
        <FailedUploadList entries={failedUploads} onRetry={onRetryUpload} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item, index) => (
            <button
              type="button"
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={`overflow-hidden rounded-lg border bg-card text-left ${
                selectedId === item.id ? "border-primary ring-2 ring-primary/25" : "border-border"
              }`}
            >
              <div className="relative aspect-square bg-secondary">
                <img
                  src={item.image_url}
                  alt={`Captured photo ${index + 1}`}
                  className="h-full w-full object-cover"
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
                {item.shot_type || "Unclassified"}
              </div>
            </button>
          ))}
        </div>
      </div>
      <aside className="ds-surface h-fit p-4 xl:sticky xl:top-20">
        {selected ? (
          <div className="space-y-3">
            <p className="text-sm font-semibold">Selected photo</p>
            <ProductSelect
              value={selected.shot_type ?? ""}
              onValueChange={(value) => onClassify(selected, value || null)}
              ariaLabel="Optional photo classification"
              emptyLabel="Unclassified"
              options={SHOT_TYPES.map((shot) => ({ value: shot.name, label: shot.name }))}
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() => onMove(selected, -1)}
                disabled={items[0]?.id === selected.id}
              >
                <ArrowUp className="size-4" /> Earlier
              </Button>
              <Button
                variant="outline"
                onClick={() => onMove(selected, 1)}
                disabled={items.at(-1)?.id === selected.id}
              >
                <ArrowDown className="size-4" /> Later
              </Button>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => onSetMain(selected)}
              disabled={selected.is_main}
            >
              <Star className="size-4" /> Mark main
            </Button>
            <Button variant="outline" className="w-full" onClick={() => onRetake(selected)}>
              <RotateCcw className="size-4" /> Retake / replace
            </Button>
            <Button
              variant="outline"
              className="w-full text-destructive hover:text-destructive"
              onClick={() => onRemove(selected)}
              disabled={busy !== null}
            >
              <Trash2 className="size-4" /> Remove photo
            </Button>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Select a photo to review.
          </p>
        )}
        <Button
          className="mt-5 min-h-12 w-full"
          onClick={onNext}
          disabled={busy !== null || pending > 0 || failed > 0 || items.length === 0 || !hasVehicle}
        >
          {busy === "next" ? "Preparing…" : "Next"} <ArrowRight className="size-4" />
        </Button>
        {!hasVehicle && (
          <p className="mt-2 text-xs text-muted-foreground">
            This legacy package must first be associated by an office administrator.
          </p>
        )}
      </aside>
    </section>
  );
}

function ProcessingStage({
  items,
  selected,
  busy,
  onChange,
  onDone,
}: {
  items: Item[];
  selected: Set<string>;
  busy: string | null;
  onChange: (value: Set<string>) => void;
  onDone: () => void;
}) {
  const choose = (ids: string[]) => onChange(new Set(ids));
  return (
    <section className="ds-surface p-4 sm:p-6">
      <div className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
            Optional background work
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">
            Select photos to process
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Jobs run privately in the background. You can move to the next vehicle immediately.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              choose(
                items.filter((item) => item.media_category === "exterior").map((item) => item.id),
              )
            }
          >
            Select exterior
          </Button>
          <Button variant="outline" size="sm" onClick={() => choose(items.map((item) => item.id))}>
            Select all
          </Button>
          <Button variant="ghost" size="sm" onClick={() => choose([])}>
            Clear
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 py-5 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item) => {
          const checked = selected.has(item.id);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                const next = new Set(selected);
                if (checked) next.delete(item.id);
                else next.add(item.id);
                onChange(next);
              }}
              className={`overflow-hidden rounded-lg border text-left ${checked ? "border-primary ring-2 ring-primary/25" : "border-border"}`}
            >
              <div className="relative aspect-square bg-secondary">
                <img src={item.image_url} alt="" className="h-full w-full object-cover" />
                <Checkbox
                  checked={checked}
                  className="pointer-events-none absolute left-2 top-2 bg-background"
                />
              </div>
              <div className="p-2 text-xs font-medium">{item.shot_type || "Photo"}</div>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {selected.size} selected · processing does not block capture completion
        </p>
        <Button className="min-h-12" onClick={onDone} disabled={busy !== null}>
          {busy === "processing" ? "Finishing…" : "Done"} <Check className="size-4" />
        </Button>
      </div>
    </section>
  );
}

function CompletionStage({
  photoCount,
  vehicleId,
  onAnother,
  onDashboard,
}: {
  photoCount: number;
  vehicleId: string | null;
  onAnother: () => void;
  onDashboard: () => void;
}) {
  return (
    <section className="ds-surface mx-auto max-w-2xl p-6 text-center sm:p-10">
      <span className="mx-auto grid size-14 place-items-center rounded-full bg-success/15 text-success">
        <CheckCircle2 className="size-7" />
      </span>
      <h2 className="mt-4 text-2xl font-semibold tracking-[-0.03em]">Vehicle capture complete</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {photoCount} private originals are safely registered. Background jobs continue
        independently.
      </p>
      <h3 className="mt-7 font-semibold">Photograph another vehicle?</h3>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Button className="min-h-12" onClick={onAnother}>
          <Camera className="size-4" /> Yes, next vehicle
        </Button>
        <Button className="min-h-12" variant="outline" onClick={onDashboard}>
          No, go to Dashboard
        </Button>
      </div>
      {vehicleId && (
        <Button asChild variant="link" className="mt-4">
          <Link to="/vehicles/$id" params={{ id: vehicleId }}>
            Open vehicle workspace
          </Link>
        </Button>
      )}
    </section>
  );
}

function ThumbnailStrip({ items }: { items: Item[] }) {
  if (!items.length)
    return (
      <div className="mt-5 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Your captured photos will appear here as uploads finish.
      </div>
    );
  return (
    <div className="mt-5 flex gap-2 overflow-x-auto pb-2">
      {items.map((item) => (
        <img
          key={item.id}
          src={item.image_url}
          alt=""
          className="size-20 shrink-0 rounded-md border border-border object-cover"
        />
      ))}
    </div>
  );
}

function FailedUploadList({
  entries,
  onRetry,
}: {
  entries: UploadEntry<BulkUpload>[];
  onRetry: (entryId: string) => void;
}) {
  if (!entries.length) return null;
  return (
    <div className="mt-4 space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      {entries.map((entry) => (
        <div key={entry.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium">
            {entry.payload?.file.name ?? "Vehicle photo"}
          </span>
          <span className="text-xs text-destructive">
            Upload failed. Check your connection and try again.
          </span>
          <Button size="sm" variant="outline" onClick={() => onRetry(entry.id)}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </div>
      ))}
    </div>
  );
}

function classifyShot(value: string | null) {
  const label = (value ?? "").toLowerCase();
  if (
    [
      "front",
      "rear",
      "driver side",
      "passenger side",
      "front 3/4",
      "rear 3/4",
      "wheel",
      "engine bay",
    ].includes(label)
  )
    return "exterior";
  if (label.includes("interior") || ["dashboard", "seats", "trunk"].includes(label))
    return "interior";
  if (label.includes("odometer")) return "odometer";
  if (label === "vin") return "vin";
  return "misc";
}

function stageLabel(stage: Session["workflow_stage"]) {
  if (stage === "review") return "Review Photos";
  if (stage === "processing") return "Processing Selection";
  if (stage === "completed") return "Complete";
  return "Taking Photos";
}

function formatElapsed(total: number) {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
