import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ImageMinus,
  LoaderCircle,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { BACKGROUND_PROCESSING_CHANGED_EVENT } from "@/lib/background-processing-events";
import { cn } from "@/lib/utils";

type ActivityStatus = "queued" | "processing" | "completed" | "failed";

type BackgroundActivity = {
  job_id: string;
  media_asset_id: string | null;
  photo_id: string | null;
  vehicle_id: string | null;
  stock_number: string | null;
  vehicle_label: string | null;
  status: ActivityStatus;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 15_000;

function isActivity(value: unknown): value is BackgroundActivity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BackgroundActivity>;
  return (
    typeof candidate.job_id === "string" &&
    (candidate.status === "queued" ||
      candidate.status === "processing" ||
      candidate.status === "completed" ||
      candidate.status === "failed")
  );
}

export function BackgroundProcessingStatus() {
  const { profile } = useAuth();
  const { selectedDealershipId, capabilities, loadingCapabilities } = useAccessibleDealerships();
  const canView =
    Boolean(selectedDealershipId) &&
    (profile?.role !== "staff" || (!loadingCapabilities && capabilities?.media === true));
  const [jobs, setJobs] = useState<BackgroundActivity[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [hiddenCompleted, setHiddenCompleted] = useState<Set<string>>(new Set());
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(async () => {
    if (!selectedDealershipId || !canView) return [];
    const { data, error } = await supabase.rpc("get_background_removal_activity", {
      _dealership_id: selectedDealershipId,
      _limit: 20,
    });
    if (error) return [];
    return Array.isArray(data) ? data.filter(isActivity) : [];
  }, [canView, selectedDealershipId]);

  useEffect(() => {
    setJobs([]);
    setHiddenCompleted(new Set());
    setExpanded(false);
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
      setJobs(next);
      const hasActive = next.some((job) => job.status === "queued" || job.status === "processing");
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

  const visibleJobs = useMemo(
    () => jobs.filter((job) => job.status !== "completed" || !hiddenCompleted.has(job.job_id)),
    [hiddenCompleted, jobs],
  );
  const counts = useMemo(
    () => ({
      queued: visibleJobs.filter((job) => job.status === "queued").length,
      processing: visibleJobs.filter((job) => job.status === "processing").length,
      completed: visibleJobs.filter((job) => job.status === "completed").length,
      failed: visibleJobs.filter((job) => job.status === "failed").length,
    }),
    [visibleJobs],
  );
  const activeCount = counts.queued + counts.processing;
  const finishedCount = counts.completed + counts.failed;

  if (!canView || visibleJobs.length === 0) return null;

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
          ) : counts.failed > 0 ? (
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
            ) : counts.failed > 0 ? (
              <AlertTriangle className="size-4 text-amber-300" aria-hidden />
            ) : (
              <CheckCircle2 className="size-4 text-emerald-300" aria-hidden />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">Background removal</span>
            <span className="block truncate text-xs text-white/65">
              {activeCount > 0
                ? `${finishedCount} of ${visibleJobs.length} finished · ${activeCount} active`
                : counts.failed > 0
                  ? `${counts.completed} complete · ${counts.failed} failed`
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
            <div className="grid grid-cols-4 gap-px bg-white/10 text-center">
              <Metric label="Queued" value={counts.queued} />
              <Metric label="Working" value={counts.processing} />
              <Metric label="Done" value={counts.completed} />
              <Metric label="Failed" value={counts.failed} danger={counts.failed > 0} />
            </div>
            <div className="max-h-64 overflow-y-auto overscroll-contain p-2">
              <ul className="space-y-1" aria-live="polite">
                {visibleJobs.map((job) => (
                  <li
                    key={job.job_id}
                    className="flex min-h-11 items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-white/5"
                  >
                    <JobIcon status={job.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {job.vehicle_label?.trim() || job.stock_number || "Vehicle photo"}
                      </span>
                      <span className="block truncate text-[11px] text-white/55">
                        {job.stock_number ? `Stock ${job.stock_number} · ` : ""}
                        {statusLabel(job)}
                      </span>
                    </span>
                  </li>
                ))}
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
              {counts.completed > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 text-xs text-white/65 hover:bg-white/10 hover:text-white"
                  onClick={() => {
                    setHiddenCompleted(
                      new Set(
                        jobs.filter((job) => job.status === "completed").map((job) => job.job_id),
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
  return <ImageMinus className="size-4 shrink-0 text-white/55" aria-hidden />;
}

function statusLabel(job: BackgroundActivity) {
  if (job.status === "queued") {
    return job.attempt_count > 0 ? "Retry queued" : "Queued";
  }
  if (job.status === "processing") return "Removing background";
  if (job.status === "completed") return "Completed";
  return "Failed — review or retry from Photo Manager";
}
