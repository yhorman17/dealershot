export type BackgroundActivityStatus =
  | "queued"
  | "processing"
  | "completed"
  | "needs_review"
  | "failed"
  | "canceled";

export type BackgroundActivity = {
  job_id: string;
  media_asset_id: string | null;
  photo_id: string | null;
  vehicle_id: string | null;
  stock_number: string | null;
  vehicle_label: string | null;
  shot_type: string | null;
  photo_sort_order: number | null;
  status: BackgroundActivityStatus;
  retryable: boolean;
  cancelable: boolean;
  cancel_requested: boolean;
  safe_failure_label: string | null;
  failure_category: string | null;
  deterministic_failure_count: number;
  has_draft: boolean;
  fix_cutout_available: boolean;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type BackgroundActivityCounts = {
  queued: number;
  processing: number;
  completed: number;
  needsReview: number;
  failed: number;
  canceled: number;
  total: number;
  terminal: number;
};

export type BackgroundActivityGroup = {
  groupKey: string;
  vehicleId: string | null;
  stockNumber: string | null;
  vehicleLabel: string | null;
  updatedAt: string;
  items: BackgroundActivity[];
  counts: BackgroundActivityCounts;
  progressPercent: number;
  retryableFailedCount: number;
  cancelableCount: number;
};

const STATUSES = new Set<BackgroundActivityStatus>([
  "queued",
  "processing",
  "completed",
  "needs_review",
  "failed",
  "canceled",
]);

export function isBackgroundActivity(value: unknown): value is BackgroundActivity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BackgroundActivity>;
  return typeof candidate.job_id === "string" && STATUSES.has(candidate.status!);
}

export function summarizeBackgroundActivity(items: BackgroundActivity[]): BackgroundActivityCounts {
  const counts: BackgroundActivityCounts = {
    queued: 0,
    processing: 0,
    completed: 0,
    needsReview: 0,
    failed: 0,
    canceled: 0,
    total: items.length,
    terminal: 0,
  };
  for (const item of items) {
    if (item.status === "needs_review") counts.needsReview += 1;
    else counts[item.status] += 1;
  }
  counts.terminal = counts.completed + counts.needsReview + counts.failed + counts.canceled;
  return counts;
}

function buildGroup(
  groupKey: string,
  vehicleId: string | null,
  stockNumber: string | null,
  vehicleLabel: string | null,
  updatedAt: string,
  items: BackgroundActivity[],
): BackgroundActivityGroup {
  const counts = summarizeBackgroundActivity(items);
  return {
    groupKey,
    vehicleId,
    stockNumber,
    vehicleLabel,
    updatedAt,
    items,
    counts,
    progressPercent: counts.total === 0 ? 0 : Math.round((counts.terminal / counts.total) * 100),
    retryableFailedCount: items.filter((item) => item.status === "failed" && item.retryable).length,
    cancelableCount: items.filter((item) => item.cancelable).length,
  };
}

export function parseBackgroundActivityGroups(value: unknown): BackgroundActivityGroup[] {
  if (!value || typeof value !== "object") return [];
  const vehicles = (value as { vehicles?: unknown }).vehicles;
  if (!Array.isArray(vehicles)) return [];

  return vehicles
    .map((entry): BackgroundActivityGroup | null => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const items = Array.isArray(row.items) ? row.items.filter(isBackgroundActivity) : [];
      if (typeof row.group_key !== "string" || items.length === 0) return null;
      return buildGroup(
        row.group_key,
        typeof row.vehicle_id === "string" ? row.vehicle_id : null,
        typeof row.stock_number === "string" ? row.stock_number : null,
        typeof row.vehicle_label === "string" ? row.vehicle_label : null,
        typeof row.updated_at === "string" ? row.updated_at : items[0]!.updated_at,
        items,
      );
    })
    .filter((group): group is BackgroundActivityGroup => group !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function filterHiddenFinishedGroups(
  groups: BackgroundActivityGroup[],
  hiddenJobIds: ReadonlySet<string>,
): BackgroundActivityGroup[] {
  return groups
    .map((group) => {
      const items = group.items.filter(
        (item) =>
          (item.status !== "completed" && item.status !== "canceled") ||
          !hiddenJobIds.has(item.job_id),
      );
      return items.length
        ? buildGroup(
            group.groupKey,
            group.vehicleId,
            group.stockNumber,
            group.vehicleLabel,
            group.updatedAt,
            items,
          )
        : null;
    })
    .filter((group): group is BackgroundActivityGroup => group !== null);
}

export function vehicleActivitySummary(group: BackgroundActivityGroup) {
  const parts = [
    group.counts.queued > 0 ? `${group.counts.queued} queued` : null,
    group.counts.processing > 0 ? `${group.counts.processing} processing` : null,
    group.counts.completed > 0 ? `${group.counts.completed} complete` : null,
    group.counts.needsReview > 0 ? `${group.counts.needsReview} review` : null,
    group.counts.failed > 0 ? `${group.counts.failed} failed` : null,
  ].filter(Boolean);
  return parts.join(" · ") || `${group.counts.canceled} canceled`;
}
