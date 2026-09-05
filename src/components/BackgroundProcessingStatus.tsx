import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ImageMinus,
  LoaderCircle,
  RotateCcw,
  Scissors,
  X,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import {
  announceBackgroundProcessingChange,
  BACKGROUND_PROCESSING_CHANGED_EVENT,
} from "@/lib/background-processing-events";
import {
  filterHiddenFinishedGroups,
  parseBackgroundActivityGroups,
  summarizeBackgroundActivity,
  vehicleActivitySummary,
  type BackgroundActivity,
  type BackgroundActivityGroup,
  type BackgroundActivityStatus as ActivityStatus,
} from "@/lib/background-processing-activity";
import { cn } from "@/lib/utils";

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 15_000;

type ProcessingAction = "retry" | "cancel";
type BulkProcessingAction = "retry_all" | "cancel_all";
type VehicleProcessingAction = "retry_vehicle" | "cancel_vehicle";

function actionResultStatus(value: unknown, fallback: ActivityStatus): ActivityStatus {
  if (!value || typeof value !== "object") return fallback;
  const status = (value as { status?: unknown }).status;
  if (status === "queued" || status === "retry_scheduled") return "queued";
  if (status === "processing" || status === "running") return "processing";
  if (status === "completed" || status === "succeeded") return "completed";
  if (status === "needs_review") return "needs_review";
  if (status === "failed" || status === "dead_letter") return "failed";
  if (status === "canceled" || status === "cancelled" || status === "cancel_requested") {
    return "canceled";
  }
  return fallback;
}

function resultCount(value: unknown, key: string) {
  if (!value || typeof value !== "object") return 0;
  const count = (value as Record<string, unknown>)[key];
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function BackgroundProcessingStatus() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { selectedDealershipId, capabilities, loadingCapabilities } = useAccessibleDealerships();
  const canView =
    Boolean(selectedDealershipId) &&
    (profile?.role !== "staff" || (!loadingCapabilities && capabilities?.media === true));
  const [groups, setGroups] = useState<BackgroundActivityGroup[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [expandedVehicles, setExpandedVehicles] = useState<Set<string>>(new Set());
  const [cameraOpen, setCameraOpen] = useState(false);
  const [hiddenFinished, setHiddenFinished] = useState<Set<string>>(new Set());
  const [refreshToken, setRefreshToken] = useState(0);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [cancelAllOpen, setCancelAllOpen] = useState(false);
  const [cancelVehicleTarget, setCancelVehicleTarget] = useState<BackgroundActivityGroup | null>(
    null,
  );
  const activeStoreRef = useRef(selectedDealershipId);

  useEffect(() => {
    activeStoreRef.current = selectedDealershipId;
  }, [selectedDealershipId]);

  const refresh = useCallback(async () => {
    if (!selectedDealershipId || !canView) return [];
    const { data, error } = await supabase.rpc("get_background_removal_activity_grouped", {
      _dealership_id: selectedDealershipId,
      _vehicle_limit: 20,
    });
    if (error) return [];
    return parseBackgroundActivityGroups(data);
  }, [canView, selectedDealershipId]);

  useEffect(() => {
    setGroups([]);
    setHiddenFinished(new Set());
    setExpanded(false);
    setExpandedVehicles(new Set());
    setSubmitting(null);
    setCancelAllOpen(false);
    setCancelVehicleTarget(null);
  }, [selectedDealershipId]);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setCameraOpen(root.dataset.bulkCameraOpen === "true");
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-bulk-camera-open"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    let timeout = 0;
    const poll = async () => {
      const next = await refresh();
      if (cancelled) return;
      setGroups(next);
      const hasActive = next.some((group) =>
        group.items.some((job) => job.status === "queued" || job.status === "processing"),
      );
      timeout = window.setTimeout(poll, hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    void poll();
    const updateNow = () => {
      window.clearTimeout(timeout);
      void poll();
    };
    window.addEventListener(BACKGROUND_PROCESSING_CHANGED_EVENT, updateNow);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.removeEventListener(BACKGROUND_PROCESSING_CHANGED_EVENT, updateNow);
    };
  }, [canView, refresh, refreshToken]);

  const visibleGroups = useMemo(
    () => filterHiddenFinishedGroups(groups, hiddenFinished),
    [groups, hiddenFinished],
  );
  const visibleJobs = useMemo(() => visibleGroups.flatMap((group) => group.items), [visibleGroups]);
  const counts = useMemo(() => summarizeBackgroundActivity(visibleJobs), [visibleJobs]);
  const activeCount = counts.queued + counts.processing;
  const finishedCount = counts.completed + counts.needsReview + counts.failed + counts.canceled;
  const retryableFailedCount = visibleJobs.filter(
    (job) => job.status === "failed" && job.retryable,
  ).length;
  const cancelableCount = visibleJobs.filter((job) => job.cancelable).length;

  const performAction = async (job: BackgroundActivity, action: ProcessingAction) => {
    if (submitting) return;
    const storeAtSubmit = selectedDealershipId;
    if (!storeAtSubmit) return;
    setSubmitting(`${action}:${job.job_id}`);
    try {
      const rpc = action === "retry" ? "retry_background_removal" : "cancel_background_removal";
      const { data, error } = await supabase.rpc(rpc, { _job_id: job.job_id });
      if (error) throw error;
      const nextStatus = actionResultStatus(data, action === "retry" ? "queued" : "canceled");

      if (activeStoreRef.current === storeAtSubmit) {
        setGroups((current) =>
          current.map((group) => ({
            ...group,
            items: group.items.map((item) =>
              item.job_id === job.job_id
                ? {
                    ...item,
                    status: nextStatus,
                    retryable: false,
                    cancelable: action === "retry",
                    cancel_requested: action === "cancel" && nextStatus === "canceled",
                    updated_at: new Date().toISOString(),
                  }
                : item,
            ),
          })),
        );
      }
      announceBackgroundProcessingChange();
      const authoritative = await refresh();
      if (activeStoreRef.current === storeAtSubmit) setGroups(authoritative);
      const completedDuringAction = nextStatus === "completed";
      toast.success(
        completedDuringAction
          ? "Background removal already completed"
          : action === "retry"
            ? "Retry queued"
            : "Processing canceled",
        {
          description: completedDuringAction
            ? "The completed cutout remains available for review."
            : action === "retry"
              ? "DealerShot will retry this photo without changing the original."
              : "The original photo remains unchanged.",
        },
      );
    } catch {
      toast.error(
        action === "retry" ? "Retry could not be queued" : "Processing could not be canceled",
        {
          description: "Your original photo was not changed. Try again.",
        },
      );
      announceBackgroundProcessingChange();
    } finally {
      if (activeStoreRef.current === storeAtSubmit) setSubmitting(null);
    }
  };

  const performBulkAction = async (action: BulkProcessingAction) => {
    if (submitting) return;
    const storeAtSubmit = selectedDealershipId;
    if (!storeAtSubmit) return;
    setSubmitting(`bulk:${action}`);
    try {
      const rpc =
        action === "retry_all" ? "retry_failed_background_removals" : "cancel_background_removals";
      const { data, error } = await supabase.rpc(rpc, { _dealership_id: storeAtSubmit });
      if (error) throw error;

      if (activeStoreRef.current === storeAtSubmit) {
        setGroups((current) =>
          current.map((group) => ({
            ...group,
            items: group.items.map((job) => {
              if (action === "retry_all" && job.status === "failed" && job.retryable) {
                return {
                  ...job,
                  status: "queued",
                  retryable: false,
                  cancelable: true,
                  updated_at: new Date().toISOString(),
                };
              }
              if (action === "cancel_all" && job.cancelable) {
                return {
                  ...job,
                  status: "canceled",
                  retryable: false,
                  cancelable: false,
                  cancel_requested: true,
                  updated_at: new Date().toISOString(),
                };
              }
              return job;
            }),
          })),
        );
      }

      if (action === "retry_all") {
        const retried = resultCount(data, "retried_count");
        const notRetryable = resultCount(data, "not_retryable_count");
        const alreadyActive = resultCount(data, "already_active_count");
        const alreadyCompleted = resultCount(data, "already_completed_count");
        const description = [
          `${retried} queued`,
          notRetryable > 0 ? `${notRetryable} not retryable` : null,
          alreadyActive > 0 ? `${alreadyActive} already active` : null,
          alreadyCompleted > 0 ? `${alreadyCompleted} already completed` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        if (retried > 0) {
          toast.success(`${retried} background-removal ${retried === 1 ? "job" : "jobs"} queued`, {
            description,
          });
        } else {
          toast.info("No failed jobs were queued", { description });
        }
      } else {
        const canceled = resultCount(data, "canceled_count");
        const cancelRequested = resultCount(data, "cancel_requested_count");
        setCancelAllOpen(false);
        toast.success("Background-removal work canceled", {
          description: `${canceled} canceled${
            cancelRequested > 0 ? ` · ${cancelRequested} finishing safely` : ""
          }. Original photos remain unchanged.`,
        });
      }

      announceBackgroundProcessingChange();
      const authoritative = await refresh();
      if (activeStoreRef.current === storeAtSubmit) setGroups(authoritative);
    } catch {
      toast.error(
        action === "retry_all"
          ? "Failed jobs could not be retried"
          : "Background-removal work could not be canceled",
        { description: "No original photos were changed. Try again." },
      );
      announceBackgroundProcessingChange();
    } finally {
      if (activeStoreRef.current === storeAtSubmit) setSubmitting(null);
    }
  };

  const performVehicleAction = async (
    group: BackgroundActivityGroup,
    action: VehicleProcessingAction,
  ) => {
    if (submitting || !group.vehicleId) return;
    const storeAtSubmit = selectedDealershipId;
    if (!storeAtSubmit) return;
    setSubmitting(`${action}:${group.groupKey}`);
    try {
      const rpc =
        action === "retry_vehicle"
          ? "retry_failed_background_removals_for_vehicle"
          : "cancel_background_removals_for_vehicle";
      const { data, error } = await supabase.rpc(rpc, {
        _dealership_id: storeAtSubmit,
        _vehicle_id: group.vehicleId,
      });
      if (error) throw error;

      if (activeStoreRef.current === storeAtSubmit) {
        setGroups((current) =>
          current.map((candidate) =>
            candidate.groupKey !== group.groupKey
              ? candidate
              : {
                  ...candidate,
                  items: candidate.items.map((job) => {
                    if (action === "retry_vehicle" && job.status === "failed" && job.retryable) {
                      return {
                        ...job,
                        status: "queued",
                        retryable: false,
                        cancelable: true,
                        updated_at: new Date().toISOString(),
                      };
                    }
                    if (action === "cancel_vehicle" && job.cancelable) {
                      return {
                        ...job,
                        status: "canceled",
                        retryable: false,
                        cancelable: false,
                        cancel_requested: true,
                        updated_at: new Date().toISOString(),
                      };
                    }
                    return job;
                  }),
                },
          ),
        );
      }

      if (action === "retry_vehicle") {
        const retried = resultCount(data, "retried_count");
        const notRetryable = resultCount(data, "not_retryable_count");
        const message = `${retried} ${retried === 1 ? "photo" : "photos"} queued for retry`;
        const options = {
          description:
            notRetryable > 0 ? `${notRetryable} cannot be retried automatically.` : undefined,
        };
        if (retried > 0) toast.success(message, options);
        else toast.info("No failed photos were queued", options);
      } else {
        const canceled = resultCount(data, "canceled_count");
        const requested = resultCount(data, "cancel_requested_count");
        setCancelVehicleTarget(null);
        toast.success("Vehicle processing canceled", {
          description: `${canceled} canceled${requested > 0 ? ` · ${requested} finishing safely` : ""}. Originals remain intact.`,
        });
      }

      announceBackgroundProcessingChange();
      const authoritative = await refresh();
      if (activeStoreRef.current === storeAtSubmit) setGroups(authoritative);
    } catch {
      toast.error(
        action === "retry_vehicle"
          ? "Vehicle retries could not be queued"
          : "Vehicle processing could not be canceled",
        { description: "No original photos were changed. Try again." },
      );
      announceBackgroundProcessingChange();
    } finally {
      if (activeStoreRef.current === storeAtSubmit) setSubmitting(null);
    }
  };

  const openFixCutout = async (job: BackgroundActivity) => {
    if (!job.fix_cutout_available || !job.vehicle_id || !job.photo_id) return;
    setExpanded(false);
    await navigate({
      to: "/vehicles/$id",
      params: { id: job.vehicle_id },
      search: { customize: job.photo_id },
    });
  };

  if (!canView || visibleGroups.length === 0) return null;

  if (cameraOpen) {
    return (
      <aside
        className="fixed left-[max(0.75rem,env(safe-area-inset-left))] top-[max(4.5rem,calc(env(safe-area-inset-top)+3.5rem))] z-[90]"
        aria-label="Background removal activity"
      >
        <div
          className="flex h-10 items-center gap-2 rounded-lg bg-slate-950/85 px-2.5 text-xs font-semibold text-white shadow-sm ring-1 ring-white/15"
          title={`${activeCount} background removal ${activeCount === 1 ? "job" : "jobs"} active`}
        >
          {activeCount > 0 ? (
            <LoaderCircle className="size-4 animate-spin text-blue-300" aria-hidden />
          ) : counts.failed > 0 || counts.needsReview > 0 ? (
            <AlertTriangle className="size-4 text-amber-300" aria-hidden />
          ) : (
            <CheckCircle2 className="size-4 text-emerald-300" aria-hidden />
          )}
          <span className="tabular-nums">
            {activeCount > 0 ? `${activeCount} processing` : `${finishedCount} finished`}
          </span>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "background-processing-widget fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-40 w-[min(22rem,calc(100vw-2rem))]",
        expanded && "is-expanded",
      )}
      aria-label="Background removal activity"
    >
      <div className="overflow-hidden rounded-xl bg-slate-950 text-white shadow-[0_8px_24px_rgb(15_23_42/0.28)] ring-1 ring-white/15">
        <button
          type="button"
          className="flex min-h-12 w-full touch-manipulation items-center gap-3 px-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <span className="relative grid size-8 shrink-0 place-items-center rounded-lg bg-blue-500/20 text-blue-200">
            {activeCount > 0 ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : counts.failed > 0 || counts.needsReview > 0 ? (
              <AlertTriangle className="size-4 text-amber-300" aria-hidden />
            ) : (
              <CheckCircle2 className="size-4 text-emerald-300" aria-hidden />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">Background removal</span>
            <span className="block truncate text-xs text-white/65">
              {activeCount > 0
                ? `${activeCount} active${counts.failed > 0 ? ` · ${counts.failed} failed` : ""}`
                : counts.needsReview > 0
                  ? `${counts.needsReview} need review · ${counts.completed} complete`
                  : counts.failed > 0
                    ? `${counts.failed} failed · ${counts.completed} complete`
                    : `${counts.completed} completed`}
            </span>
          </span>
          {expanded ? (
            <ChevronDown className="size-4 text-white/60" aria-hidden />
          ) : (
            <ChevronUp className="size-4 text-white/60" aria-hidden />
          )}
        </button>

        {expanded && (
          <div className="motion-content border-t border-white/10">
            <div className="grid grid-cols-5 gap-px bg-white/10 text-center">
              <Metric label="Queued" value={counts.queued} />
              <Metric label="Working" value={counts.processing} />
              <Metric label="Done" value={counts.completed} />
              <Metric label="Review" value={counts.needsReview} danger={counts.needsReview > 0} />
              <Metric label="Failed" value={counts.failed} danger={counts.failed > 0} />
            </div>
            {(retryableFailedCount > 0 || cancelableCount > 0) && (
              <div className="flex flex-wrap gap-2 border-t border-white/10 px-2.5 py-2">
                {retryableFailedCount > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-10 flex-1 touch-manipulation border-blue-300/25 bg-blue-400/10 px-3 text-xs text-blue-100 hover:bg-blue-400/20 hover:text-white"
                    disabled={submitting !== null}
                    onClick={() => void performBulkAction("retry_all")}
                  >
                    {submitting === "bulk:retry_all" ? (
                      <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <RotateCcw className="size-3.5" aria-hidden />
                    )}
                    Retry All Failed
                  </Button>
                )}
                {cancelableCount > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-10 flex-1 touch-manipulation px-3 text-xs text-white/70 hover:bg-white/10 hover:text-white"
                    disabled={submitting !== null}
                    onClick={() => setCancelAllOpen(true)}
                  >
                    <Ban className="size-3.5" aria-hidden />
                    Cancel All
                  </Button>
                )}
              </div>
            )}
            <div className="processing-widget-scrollbar max-h-64 overflow-y-auto overscroll-contain p-2">
              <ul className="space-y-1" aria-live="polite">
                {visibleGroups.map((group) => {
                  const vehicleExpanded = expandedVehicles.has(group.groupKey);
                  const finishedIds = group.items
                    .filter((job) => job.status === "completed" || job.status === "canceled")
                    .map((job) => job.job_id);
                  return (
                    <li key={group.groupKey} className="rounded-lg bg-white/[0.035]">
                      <button
                        type="button"
                        className="flex min-h-12 w-full touch-manipulation items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400"
                        onClick={() =>
                          setExpandedVehicles((current) => {
                            const next = new Set(current);
                            if (next.has(group.groupKey)) next.delete(group.groupKey);
                            else next.add(group.groupKey);
                            return next;
                          })
                        }
                        aria-expanded={vehicleExpanded}
                      >
                        {vehicleExpanded ? (
                          <ChevronDown className="size-4 shrink-0 text-white/45" aria-hidden />
                        ) : (
                          <ChevronRight className="size-4 shrink-0 text-white/45" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="block min-w-0 flex-1 truncate text-xs font-semibold">
                              {group.vehicleLabel?.trim() || group.stockNumber || "Vehicle"}
                            </span>
                            <span className="shrink-0 text-[10px] tabular-nums text-white/50">
                              {group.counts.terminal}/{group.counts.total}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-white/55">
                            {group.stockNumber ? `Stock ${group.stockNumber} · ` : ""}
                            {vehicleActivitySummary(group)}
                          </span>
                          <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-white/10">
                            <span
                              className="block h-full rounded-full bg-blue-400 transition-[width] duration-300"
                              style={{ width: `${group.progressPercent}%` }}
                              role="progressbar"
                              aria-label={`${group.vehicleLabel || "Vehicle"} background processing`}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={group.progressPercent}
                            />
                          </span>
                        </span>
                      </button>

                      {(group.retryableFailedCount > 0 ||
                        group.cancelableCount > 0 ||
                        finishedIds.length > 0) && (
                        <div className="flex flex-wrap gap-1 border-t border-white/[0.06] px-2 py-1.5">
                          {group.retryableFailedCount > 0 && group.vehicleId && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-9 touch-manipulation px-2 text-[11px] text-blue-200 hover:bg-blue-400/15 hover:text-blue-100"
                              disabled={submitting !== null}
                              onClick={() => void performVehicleAction(group, "retry_vehicle")}
                            >
                              {submitting === `retry_vehicle:${group.groupKey}` ? (
                                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                              ) : (
                                <RotateCcw className="size-3.5" aria-hidden />
                              )}
                              Retry failed
                            </Button>
                          )}
                          {group.cancelableCount > 0 && group.vehicleId && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-9 touch-manipulation px-2 text-[11px] text-white/65 hover:bg-white/10 hover:text-white"
                              disabled={submitting !== null}
                              onClick={() => setCancelVehicleTarget(group)}
                            >
                              <Ban className="size-3.5" aria-hidden />
                              Cancel active
                            </Button>
                          )}
                          {finishedIds.length > 0 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="ml-auto h-9 touch-manipulation px-2 text-[11px] text-white/55 hover:bg-white/10 hover:text-white"
                              onClick={() =>
                                setHiddenFinished(
                                  (current) => new Set([...current, ...finishedIds]),
                                )
                              }
                            >
                              Clear finished
                            </Button>
                          )}
                        </div>
                      )}

                      {vehicleExpanded && (
                        <ul className="space-y-1 border-t border-white/[0.06] p-1.5">
                          {group.items.map((job, index) => (
                            <li
                              key={job.job_id}
                              className="rounded-md px-2 py-1.5 hover:bg-white/5"
                            >
                              <div className="flex min-h-7 items-center gap-2">
                                <JobIcon status={job.status} />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[11px] font-medium">
                                    {job.shot_type?.trim() ||
                                      `Photo ${job.photo_sort_order != null ? job.photo_sort_order + 1 : index + 1}`}
                                  </span>
                                  <span className="block truncate text-[10px] text-white/50">
                                    {statusLabel(job)}
                                  </span>
                                </span>
                              </div>
                              {(job.retryable || job.cancelable || job.fix_cutout_available) && (
                                <div className="mt-1 flex flex-wrap justify-end gap-1">
                                  {job.fix_cutout_available && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-9 touch-manipulation px-2 text-[11px] text-amber-200 hover:bg-amber-400/15 hover:text-amber-100"
                                      disabled={submitting !== null}
                                      onClick={() => void openFixCutout(job)}
                                    >
                                      <Scissors className="size-3.5" aria-hidden /> Fix Cutout
                                    </Button>
                                  )}
                                  {job.retryable && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-9 touch-manipulation px-2 text-[11px] text-blue-200 hover:bg-blue-400/15 hover:text-blue-100"
                                      disabled={submitting !== null}
                                      onClick={() => void performAction(job, "retry")}
                                    >
                                      <RotateCcw className="size-3.5" aria-hidden /> Retry
                                    </Button>
                                  )}
                                  {job.cancelable && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-9 touch-manipulation px-2 text-[11px] text-white/65 hover:bg-white/10 hover:text-white"
                                      disabled={submitting !== null}
                                      onClick={() => void performAction(job, "cancel")}
                                    >
                                      <Ban className="size-3.5" aria-hidden /> Cancel
                                    </Button>
                                  )}
                                </div>
                              )}
                              {(job.status === "failed" || job.status === "needs_review") &&
                                job.safe_failure_label && (
                                  <p className="mt-1 text-[10px] leading-4 text-amber-100/75">
                                    {job.safe_failure_label}
                                  </p>
                                )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="flex items-center justify-between border-t border-white/10 px-2 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 text-xs text-white/65 hover:bg-white/10 hover:text-white"
                onClick={() => setExpanded(false)}
              >
                <X className="size-3.5" aria-hidden /> Minimize
              </Button>
              {counts.completed + counts.canceled > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 text-xs text-white/65 hover:bg-white/10 hover:text-white"
                  onClick={() => {
                    setHiddenFinished(
                      new Set(
                        groups
                          .flatMap((group) => group.items)
                          .filter((job) => job.status === "completed" || job.status === "canceled")
                          .map((job) => job.job_id),
                      ),
                    );
                    setRefreshToken((value) => value + 1);
                  }}
                >
                  Clear finished
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      <AlertDialog open={cancelAllOpen} onOpenChange={setCancelAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel all background-removal work?</AlertDialogTitle>
            <AlertDialogDescription>
              Queued work will stop, running work will finish safely without promoting its result,
              and failed requests will be closed. Original photos and completed cutouts remain
              intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting !== null}>Keep processing</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting !== null}
              onClick={(event) => {
                event.preventDefault();
                void performBulkAction("cancel_all");
              }}
            >
              {submitting === "bulk:cancel_all" && (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              )}
              Cancel all processing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={cancelVehicleTarget !== null}
        onOpenChange={(open) => !open && setCancelVehicleTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel processing for this vehicle?</AlertDialogTitle>
            <AlertDialogDescription>
              Queued photos will stop and running work will finish safely without promoting its
              result. Original photos and completed cutouts remain intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting !== null}>Keep processing</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting !== null || !cancelVehicleTarget}
              onClick={(event) => {
                event.preventDefault();
                if (cancelVehicleTarget) {
                  void performVehicleAction(cancelVehicleTarget, "cancel_vehicle");
                }
              }}
            >
              {cancelVehicleTarget &&
                submitting === `cancel_vehicle:${cancelVehicleTarget.groupKey}` && (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                )}
              Cancel vehicle processing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

function Metric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className="bg-slate-950 px-1 py-2">
      <span className={cn("block text-sm font-semibold tabular-nums", danger && "text-amber-300")}>
        {value}
      </span>
      <span className="block text-[10px] text-white/45">{label}</span>
    </div>
  );
}

function JobIcon({ status }: { status: ActivityStatus }) {
  if (status === "processing") {
    return <LoaderCircle className="size-4 shrink-0 animate-spin text-blue-300" aria-hidden />;
  }
  if (status === "completed") {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-300" aria-hidden />;
  }
  if (status === "failed") {
    return <AlertTriangle className="size-4 shrink-0 text-amber-300" aria-hidden />;
  }
  if (status === "needs_review") {
    return <AlertTriangle className="size-4 shrink-0 text-amber-300" aria-hidden />;
  }
  if (status === "canceled") {
    return <Ban className="size-4 shrink-0 text-white/45" aria-hidden />;
  }
  return <ImageMinus className="size-4 shrink-0 text-white/55" aria-hidden />;
}

function statusLabel(job: BackgroundActivity) {
  if (job.status === "queued") {
    return job.attempt_count > 0 ? "Retry queued" : "Queued";
  }
  if (job.status === "processing") return "Removing background";
  if (job.status === "completed") return "Completed";
  if (job.status === "needs_review") return "Needs review — original retained";
  if (job.status === "canceled") return "Canceled — original retained";
  return "Failed";
}
