import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ClipboardCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { BulkCamera } from "@/components/BulkCamera";
import {
  VehiclePhotoProcessingStage,
  VehiclePhotoReviewStage,
  type ReviewPhotoItem,
  type ReviewProcessingState,
} from "@/components/VehiclePhotoReviewStages";
import { EmptyState, PageHeader, PageSkeleton, StatusBadge } from "@/components/product-ui";
import { Button } from "@/components/ui/button";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import {
  archivePrivateMedia,
  resolveAuthorizedMediaUrls,
  uploadPrivateOriginal,
} from "@/lib/private-media";
import { announceBackgroundProcessingChange } from "@/lib/background-processing-events";
import {
  describeBackgroundRemovalQueueResult,
  parseBackgroundRemovalQueueResult,
  selectedMediaAssetIds,
} from "@/lib/background-removal-queue";

type ReviewSearch = { from?: "inventory" | "vehicle" };

export const Route = createFileRoute("/_authenticated/vehicles/$id_/review")({
  validateSearch: (search: Record<string, unknown>): ReviewSearch => ({
    from: search.from === "inventory" ? "inventory" : "vehicle",
  }),
  head: () => ({ meta: [{ title: "Review Vehicle Photos — DealerShot" }] }),
  component: ExistingVehicleReviewPage,
});

type Vehicle = {
  id: string;
  dealership_id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  vin: string | null;
  stock_number: string | null;
};

type PhotoRow = {
  id: string;
  media_asset_id: string;
  shot_type: string | null;
  media_category: string;
  sort_order: number;
  is_main: boolean;
  created_at: string;
  processing_status: "not_required" | "queued" | "processing" | "completed" | "failed";
  review_status: "unreviewed" | "awaiting_review" | "approved" | "rejected";
};

function ExistingVehicleReviewPage() {
  const { id } = Route.useParams();
  const { from } = Route.useSearch();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { capabilities, loadingCapabilities, selectedDealershipId, setSelectedDealershipId } =
    useAccessibleDealerships();
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [items, setItems] = useState<ReviewPhotoItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedForProcessing, setSelectedForProcessing] = useState<Set<string>>(new Set());
  const [reprocessCompleted, setReprocessCompleted] = useState(false);
  const [stage, setStage] = useState<"review" | "processing">("review");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retakeItem, setRetakeItem] = useState<ReviewPhotoItem | null>(null);
  const canReview =
    !loadingCapabilities &&
    (profile?.role === "owner" || profile?.role === "dealer_admin" || capabilities?.media === true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [{ data: vehicleData, error: vehicleError }, { data: photoData, error: photoError }] =
      await Promise.all([
        supabase
          .from("vehicles")
          .select("id, dealership_id, year, make, model, vin, stock_number")
          .eq("id", id)
          .maybeSingle(),
        supabase
          .from("photos")
          .select(
            "id, media_asset_id, shot_type, media_category, sort_order, is_main, created_at, processing_status, review_status",
          )
          .eq("vehicle_id", id)
          .order("sort_order")
          .order("created_at"),
      ]);
    if (vehicleError || photoError || !vehicleData) {
      setVehicle(null);
      setItems([]);
      setError("This vehicle is unavailable or outside your store access.");
      setLoading(false);
      return;
    }

    const photos = (photoData ?? []) as PhotoRow[];
    const mediaIds = photos.map((photo) => photo.media_asset_id);
    const [{ data: variants }, urls] = await Promise.all([
      mediaIds.length
        ? supabase
            .from("media_variants")
            .select("media_asset_id, variant_type, processing_status, archived_at")
            .in("media_asset_id", mediaIds)
            .in("variant_type", ["cutout", "corrected_cutout"])
        : Promise.resolve({ data: [] }),
      resolveAuthorizedMediaUrls(mediaIds, "thumbnail"),
    ]);
    const readyAssets = new Set(
      (variants ?? [])
        .filter(
          (variant) => variant.processing_status === "completed" && variant.archived_at === null,
        )
        .map((variant) => variant.media_asset_id)
        .filter((value): value is string => Boolean(value)),
    );
    const nextItems = photos.map((photo) => ({
      ...photo,
      image_url: urls.get(photo.media_asset_id) ?? "",
      processing_state: processingState(photo, readyAssets.has(photo.media_asset_id)),
    }));
    const nextVehicle = vehicleData as Vehicle;
    setVehicle(nextVehicle);
    setItems(nextItems);
    setSelectedId((current) =>
      current && nextItems.some((item) => item.id === current)
        ? current
        : (nextItems[0]?.id ?? null),
    );
    if (selectedDealershipId !== nextVehicle.dealership_id) {
      setSelectedDealershipId(nextVehicle.dealership_id);
    }
    setLoading(false);
  }, [id, selectedDealershipId, setSelectedDealershipId]);

  useEffect(() => void load(), [load]);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  const updateClassification = async (item: ReviewPhotoItem, shotType: string | null) => {
    const { error: updateError } = await supabase
      .from("photos")
      .update({ shot_type: shotType })
      .eq("id", item.id)
      .eq("vehicle_id", id);
    if (updateError) toast.error("Photo label could not be saved");
    else await load();
  };

  const setMain = async (item: ReviewPhotoItem) => {
    const { error: updateError } = await supabase.rpc("set_vehicle_primary_asset", {
      _vehicle_id: id,
      _asset_type: "photo",
      _asset_id: item.id,
    });
    if (updateError) toast.error("Main image could not be changed");
    else await load();
  };

  const move = async (item: ReviewPhotoItem, direction: -1 | 1) => {
    const index = items.findIndex((candidate) => candidate.id === item.id);
    if (!items[index + direction]) return;
    const next = [...items];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    const { error: reorderError } = await supabase.rpc("reorder_vehicle_gallery", {
      _vehicle_id: id,
      _items: next.map((entry, position) => ({
        type: "photo",
        id: entry.id,
        position: position + 1,
      })),
    });
    if (reorderError) toast.error("Photo order could not be saved");
    else await load();
  };

  const remove = async (item: ReviewPhotoItem) => {
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

  const replace = async (file: File) => {
    if (!retakeItem || busy) return;
    setBusy(`retake:${retakeItem.id}`);
    try {
      await uploadPrivateOriginal({ file, vehicleId: id, sortOrder: retakeItem.sort_order });
      await archivePrivateMedia(retakeItem.media_asset_id);
      setRetakeItem(null);
      await load();
      toast.success("Replacement uploaded", {
        description: "The previous original remains in DealerShot's audit lineage.",
      });
    } catch (reason) {
      toast.error("Replacement could not be uploaded", {
        description: reason instanceof Error ? reason.message : "Try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    if (busy) return;
    setBusy("processing");
    try {
      const mediaIds = selectedMediaAssetIds(items, selectedForProcessing);
      const { data, error: queueError } = await supabase.rpc(
        (reprocessCompleted
          ? "reprocess_vehicle_background_removal"
          : "queue_vehicle_background_removal") as never,
        { _vehicle_id: id, _media_asset_ids: mediaIds } as never,
      );
      if (queueError) throw queueError;
      const result = parseBackgroundRemovalQueueResult(data);
      const feedback = describeBackgroundRemovalQueueResult(result, {
        explicitReprocess: reprocessCompleted,
      });
      if (result.queued_count) announceBackgroundProcessingChange();
      toast[feedback.kind](feedback.title, { description: feedback.description });
      if (!feedback.shouldLeaveReview) {
        await load();
        return;
      }
      await navigate(
        from === "inventory"
          ? { to: "/inventory" }
          : {
              to: "/vehicles/$id",
              params: { id },
              search: { customize: undefined, capture: undefined },
            },
      );
    } catch (reason) {
      toast.error("Background processing could not be queued", {
        description: reason instanceof Error ? reason.message : "Try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  if (loading || loadingCapabilities) return <PageSkeleton cards={3} rows={6} />;
  if (error || !vehicle) {
    return (
      <main className="ds-page-gutter">
        <div className="ds-surface">
          <EmptyState
            icon={<ClipboardCheck className="size-5" />}
            title="Photo review unavailable"
            description={error ?? "This vehicle is no longer available."}
            action={
              <Button asChild variant="outline">
                <Link to="/inventory">Back to inventory</Link>
              </Button>
            }
          />
        </div>
      </main>
    );
  }
  if (!canReview) {
    return (
      <main className="ds-page-gutter">
        <div className="ds-surface">
          <EmptyState
            icon={<ClipboardCheck className="size-5" />}
            title="Media review access required"
            description="Your current store permissions do not include vehicle photo review."
            action={
              <Button asChild variant="outline">
                <Link to="/vehicles/$id" params={{ id }}>
                  Back to vehicle
                </Link>
              </Button>
            }
          />
        </div>
      </main>
    );
  }

  return (
    <main className="ds-page-gutter">
      <Button asChild variant="ghost" className="mb-3 -ml-3">
        <Link to="/vehicles/$id" params={{ id }}>
          <ArrowLeft className="size-4" /> Vehicle workspace
        </Link>
      </Button>
      <PageHeader
        eyebrow="Vehicle media · Office review"
        title={`${vehicle.year ?? ""} ${vehicle.make ?? ""} ${vehicle.model ?? ""}`.trim()}
        description={`${items.length} active photos · No capture session or timer is started`}
        actions={
          <StatusBadge tone="info">
            {stage === "review" ? "Review" : "Processing selection"}
          </StatusBadge>
        }
      />
      {items.length === 0 ? (
        <div className="ds-surface">
          <EmptyState
            icon={<ClipboardCheck className="size-5" />}
            title="No photos to review"
            description="Capture or upload photos from the vehicle workspace, then return here."
            action={
              <Button asChild>
                <Link to="/vehicles/$id" params={{ id }}>
                  Open vehicle media
                </Link>
              </Button>
            }
          />
        </div>
      ) : stage === "review" ? (
        <VehiclePhotoReviewStage
          items={items}
          selected={selected}
          selectedId={selectedId}
          pending={0}
          failed={0}
          busy={busy}
          onSelect={setSelectedId}
          onRetake={setRetakeItem}
          onRemove={(item) => void remove(item)}
          onClassify={(item, value) => void updateClassification(item, value)}
          onSetMain={(item) => void setMain(item)}
          onMove={(item, direction) => void move(item, direction)}
          onNext={() => setStage("processing")}
          hasVehicle
        />
      ) : (
        <VehiclePhotoProcessingStage
          items={items}
          selected={selectedForProcessing}
          busy={busy}
          onChange={setSelectedForProcessing}
          onDone={() => void finish()}
          reprocessCompleted={reprocessCompleted}
          onReprocessCompletedChange={setReprocessCompleted}
        />
      )}
      {retakeItem && (
        <BulkCamera
          capturedCount={items.length}
          uploadingCount={busy?.startsWith("retake:") ? 1 : 0}
          failedCount={0}
          uploads={[]}
          onRetryUpload={() => undefined}
          doneLabel="Cancel retake"
          onCapture={(file) => void replace(file)}
          onDone={() => {
            if (!busy) setRetakeItem(null);
          }}
        />
      )}
    </main>
  );
}

function processingState(photo: PhotoRow, hasCutout: boolean): ReviewProcessingState {
  if (photo.processing_status === "queued") return "queued";
  if (photo.processing_status === "processing") return "processing";
  if (photo.processing_status === "failed") return "failed";
  if (hasCutout && photo.review_status === "awaiting_review") return "needs_review";
  if (hasCutout) return "ready";
  return "original";
}
