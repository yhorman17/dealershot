export const MEDIA_CATEGORIES = [
  "exterior",
  "interior",
  "detail",
  "odometer",
  "vin",
  "document",
  "misc",
] as const;

export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];
export type MediaKind = "photo" | "video" | "exterior_360" | "interior_360";
export type ProcessingAction =
  | "keep_original"
  | "enhance"
  | "background_replace"
  | "background_merchandising"
  | "manual_review";

export type ProcessingRule = {
  mediaCategory: MediaCategory;
  action: ProcessingAction;
  enabled: boolean;
  priority?: number;
};

const SHOT_CATEGORIES: Record<string, MediaCategory> = {
  front: "exterior",
  rear: "exterior",
  "driver side": "exterior",
  "passenger side": "exterior",
  "front 3/4": "exterior",
  "rear 3/4": "exterior",
  wheel: "exterior",
  "engine bay": "exterior",
  dashboard: "interior",
  "front seats": "interior",
  "rear seats": "interior",
  infotainment: "interior",
  "steering wheel": "interior",
  "instrument cluster": "interior",
  "center console": "interior",
  cargo: "interior",
  "door controls": "interior",
  odometer: "odometer",
  vin: "vin",
};

export function classifyShot(shotType: string | null | undefined): MediaCategory {
  const normalized = shotType?.trim().toLowerCase();
  if (!normalized) return "misc";
  if (SHOT_CATEGORIES[normalized]) return SHOT_CATEGORIES[normalized];
  if (normalized.includes("interior")) return "interior";
  if (normalized.includes("detail")) return "detail";
  return "misc";
}

export function resolveProcessingAction(input: {
  category: MediaCategory;
  rules: ProcessingRule[];
  explicitlyRequested: boolean;
}): ProcessingAction {
  // Capture is persistence-only. Expensive media work never enters the lot
  // workflow unless an office user explicitly starts preparation.
  if (!input.explicitlyRequested) return "keep_original";
  const rule = input.rules
    .filter((candidate) => candidate.enabled && candidate.mediaCategory === input.category)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
  return rule?.action ?? "keep_original";
}

export function preservesOriginal(input: {
  originalUrl: string;
  variantUrl: string;
  variantType: string;
}): boolean {
  return input.variantType === "original" || input.originalUrl !== input.variantUrl;
}
