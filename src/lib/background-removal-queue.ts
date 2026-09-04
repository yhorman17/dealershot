export type BackgroundRemovalQueueOutcome =
  | "queued"
  | "already_active"
  | "already_completed"
  | "needs_review_existing"
  | "invalid_media"
  | "failed_to_queue";

export type BackgroundRemovalQueueItem = {
  media_asset_id: string;
  photo_id?: string;
  job_id?: string;
  outcome: BackgroundRemovalQueueOutcome;
  reprocess?: boolean;
};

export type BackgroundRemovalQueueResult = {
  selected_count: number;
  queued_count: number;
  already_active_count: number;
  already_completed_count: number;
  needs_review_existing_count: number;
  invalid_media_count: number;
  failed_to_queue_count: number;
  reprocessed_count: number;
  skipped_count: number;
  outcomes: BackgroundRemovalQueueItem[];
};

type ReviewQueueItem = {
  id: string;
  media_asset_id: string;
  media_category: string;
  processing_state?: string;
};

export type BackgroundRemovalQueueFeedback = {
  kind: "success" | "info" | "warning" | "error";
  title: string;
  description: string;
  shouldLeaveReview: boolean;
};

export function queueableReviewPhotoIds(
  items: ReviewQueueItem[],
  exteriorOnly = false,
  includeCompleted = false,
) {
  return items
    .filter(
      (item) =>
        item.processing_state !== "queued" &&
        item.processing_state !== "processing" &&
        (includeCompleted || item.processing_state !== "ready") &&
        (!exteriorOnly || item.media_category === "exterior"),
    )
    .map((item) => item.id);
}

export function selectedMediaAssetIds(
  items: ReviewQueueItem[],
  selectedPhotoIds: ReadonlySet<string>,
) {
  return items.filter((item) => selectedPhotoIds.has(item.id)).map((item) => item.media_asset_id);
}

export function parseBackgroundRemovalQueueResult(value: unknown): BackgroundRemovalQueueResult {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const count = (key: string) => {
    const candidate = source[key];
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(0, Math.trunc(candidate))
      : 0;
  };
  const outcomes = Array.isArray(source.outcomes)
    ? source.outcomes.filter(isBackgroundRemovalQueueItem)
    : [];
  return {
    selected_count: count("selected_count"),
    queued_count: count("queued_count"),
    already_active_count: count("already_active_count"),
    already_completed_count: count("already_completed_count"),
    needs_review_existing_count: count("needs_review_existing_count"),
    invalid_media_count: count("invalid_media_count"),
    failed_to_queue_count: count("failed_to_queue_count"),
    reprocessed_count: count("reprocessed_count"),
    skipped_count: count("skipped_count"),
    outcomes,
  };
}

export function describeBackgroundRemovalQueueResult(
  result: BackgroundRemovalQueueResult,
  options: { explicitReprocess?: boolean } = {},
): BackgroundRemovalQueueFeedback {
  const parts = [
    result.queued_count
      ? options.explicitReprocess
        ? `${result.queued_count} queued from original`
        : `${result.queued_count} queued`
      : "",
    result.already_active_count ? `${result.already_active_count} already processing` : "",
    result.already_completed_count ? `${result.already_completed_count} already completed` : "",
    result.needs_review_existing_count
      ? `${result.needs_review_existing_count} existing draft${result.needs_review_existing_count === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean);

  if (result.failed_to_queue_count > 0 || result.invalid_media_count > 0) {
    const failures = result.failed_to_queue_count + result.invalid_media_count;
    return {
      kind: "error",
      title: "Background processing could not be queued",
      description: `${failures} selected ${failures === 1 ? "photo" : "photos"} could not be queued safely. Review the selection and try again.`,
      shouldLeaveReview: false,
    };
  }
  if (result.queued_count > 0) {
    return {
      kind: "success",
      title: options.explicitReprocess
        ? "Automatic cutout reprocessing queued"
        : "Photo review complete",
      description: options.explicitReprocess
        ? `${parts.join(" · ")}. DealerShot will use the immutable original and make a successful new cutout active.`
        : `${parts.join(" · ")}. Processing continues in the background.`,
      shouldLeaveReview: true,
    };
  }
  if (result.selected_count === 0) {
    return {
      kind: "info",
      title: "Photo review complete",
      description: "No photos were selected for background removal.",
      shouldLeaveReview: true,
    };
  }
  if (result.already_active_count === result.selected_count) {
    return {
      kind: "info",
      title: "Selected photos are already processing",
      description:
        "No duplicate jobs were created. Progress remains visible in the processing widget.",
      shouldLeaveReview: true,
    };
  }
  if (result.already_completed_count === result.selected_count) {
    return {
      kind: "success",
      title: "No new work was needed",
      description: "All selected photos already have completed cutouts.",
      shouldLeaveReview: true,
    };
  }
  if (result.needs_review_existing_count === result.selected_count) {
    return {
      kind: "warning",
      title: "Existing cutouts need review",
      description:
        "DealerShot kept the existing draft cutouts for Fix Cutout instead of duplicating work.",
      shouldLeaveReview: true,
    };
  }
  return {
    kind: "info",
    title: "No new background work was needed",
    description: parts.length
      ? `${parts.join(" · ")}.`
      : "The selected photos did not require new work.",
    shouldLeaveReview: true,
  };
}

function isBackgroundRemovalQueueItem(value: unknown): value is BackgroundRemovalQueueItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.media_asset_id === "string" &&
    [
      "queued",
      "already_active",
      "already_completed",
      "needs_review_existing",
      "invalid_media",
      "failed_to_queue",
    ].includes(String(item.outcome))
  );
}
