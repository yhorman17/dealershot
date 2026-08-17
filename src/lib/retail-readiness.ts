export type ReadinessStatus =
  | "retail_ready"
  | "needs_attention"
  | "blocked"
  | "processing"
  | "awaiting_review";

export type ReadinessReason = {
  key: string;
  label: string;
  severity: "attention" | "blocked";
  details?: Record<string, unknown>;
};

export type ReadinessRule = {
  key: string;
  label: string;
  severity: "attention" | "blocked";
  enabled: boolean;
  appliesTo: Array<"new" | "used" | "certified">;
  minimum?: number;
  shotType?: string;
};

export type ReadinessInput = {
  inventoryType: "new" | "used" | "certified";
  vin?: string | null;
  stockNumber?: string | null;
  price?: number | null;
  comments?: string | null;
  photos: Array<{
    kind: "photo" | "video" | "exterior_360" | "interior_360";
    shotType?: string | null;
    processingStatus?: "not_required" | "queued" | "processing" | "completed" | "failed";
    reviewStatus?: "unreviewed" | "awaiting_review" | "approved" | "rejected";
  }>;
  generatedDocumentTypes?: string[];
  requiredDocumentTypes?: string[];
  rules: ReadinessRule[];
};

export type ReadinessEvaluation = {
  status: ReadinessStatus;
  reasons: ReadinessReason[];
  photoCount: number;
  videoCount: number;
};

const hasText = (value: string | null | undefined) => Boolean(value?.trim());

export function evaluateRetailReadiness(input: ReadinessInput): ReadinessEvaluation {
  const applicableRules = input.rules.filter(
    (rule) => rule.enabled && rule.appliesTo.includes(input.inventoryType),
  );
  const photoCount = input.photos.filter((photo) => photo.kind === "photo").length;
  const videoCount = input.photos.filter((photo) => photo.kind === "video").length;
  const reasons: ReadinessReason[] = [];

  for (const rule of applicableRules) {
    let satisfied = true;
    switch (rule.key) {
      case "vehicle.vin":
        satisfied = hasText(input.vin);
        break;
      case "vehicle.stock_number":
        satisfied = hasText(input.stockNumber);
        break;
      case "vehicle.price":
        satisfied = input.price !== null && input.price !== undefined;
        break;
      case "vehicle.comments":
        satisfied = hasText(input.comments);
        break;
      case "media.minimum_photos":
        satisfied = photoCount >= Math.max(0, rule.minimum ?? 0);
        break;
      case "media.required_shot":
        satisfied = input.photos.some(
          (photo) =>
            photo.kind === "photo" &&
            photo.shotType?.trim().toLowerCase() === rule.shotType?.trim().toLowerCase(),
        );
        break;
      case "media.video":
        satisfied = videoCount > 0;
        break;
      case "media.exterior_360":
        satisfied = input.photos.some((photo) => photo.kind === "exterior_360");
        break;
      case "media.interior_360":
        satisfied = input.photos.some((photo) => photo.kind === "interior_360");
        break;
      case "processing.no_failures":
        satisfied = !input.photos.some((photo) => photo.processingStatus === "failed");
        break;
    }
    if (!satisfied) {
      reasons.push({
        key: rule.key,
        label: rule.label,
        severity: rule.severity,
        details:
          rule.minimum === undefined && rule.shotType === undefined
            ? undefined
            : { minimum: rule.minimum, shotType: rule.shotType },
      });
    }
  }

  const generated = new Set(input.generatedDocumentTypes ?? []);
  for (const documentType of input.requiredDocumentTypes ?? []) {
    if (!generated.has(documentType)) {
      reasons.push({
        key: `document.${documentType}`,
        label: `${titleCase(documentType)} required`,
        severity: "attention",
      });
    }
  }

  const hasFailure = input.photos.some((photo) => photo.processingStatus === "failed");
  const isProcessing = input.photos.some(
    (photo) => photo.processingStatus === "queued" || photo.processingStatus === "processing",
  );
  const awaitsReview = input.photos.some((photo) => photo.reviewStatus === "awaiting_review");
  const status: ReadinessStatus =
    hasFailure || reasons.some((reason) => reason.severity === "blocked")
      ? "blocked"
      : isProcessing
        ? "processing"
        : awaitsReview
          ? "awaiting_review"
          : reasons.length > 0
            ? "needs_attention"
            : "retail_ready";

  return { status, reasons, photoCount, videoCount };
}

export function readinessLabel(status: ReadinessStatus): string {
  return titleCase(status);
}

export function parseReadinessReasons(value: unknown): ReadinessReason[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.key !== "string" || typeof candidate.label !== "string") return [];
    return [
      {
        key: candidate.key,
        label: candidate.label,
        severity: candidate.severity === "blocked" ? "blocked" : "attention",
        details:
          candidate.details && typeof candidate.details === "object"
            ? (candidate.details as Record<string, unknown>)
            : undefined,
      },
    ];
  });
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
