import { supabase } from "@/integrations/supabase/client";
import {
  archivePrivateMediaAsset,
  finalizePrivateMediaUpload,
  finalizePrivateVariantUpload,
  getAuthorizedMediaUrls,
  getAuthorizedMediaVariantUrl,
  preparePrivateMediaUpload,
  preparePrivateVariantUpload,
} from "@/lib/api/media.functions";

export type MediaPurpose = "thumbnail" | "preview" | "original" | "editor" | "download";

type CachedMediaUrl = {
  url: string;
  expiresAt: number;
  variantId: string | null;
  variantType: string;
};

const cache = new Map<string, CachedMediaUrl>();
const CACHE_SAFETY_MS = 30_000;
const SUPPORTED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

export function normalizedImageMime(type: string, filename = "") {
  const normalized = type.toLowerCase() === "image/jpg" ? "image/jpeg" : type.toLowerCase();
  if (SUPPORTED_IMAGE_MIME.includes(normalized as (typeof SUPPORTED_IMAGE_MIME)[number])) {
    return normalized as (typeof SUPPORTED_IMAGE_MIME)[number];
  }
  const extension = filename.toLowerCase().split(".").pop();
  if (!normalized && (extension === "jpg" || extension === "jpeg")) return "image/jpeg";
  if (!normalized && extension === "png") return "image/png";
  if (!normalized && extension === "webp") return "image/webp";
  return null;
}

function cacheKey(mediaAssetId: string, purpose: MediaPurpose) {
  return `${purpose}:${mediaAssetId}`;
}

function variantCacheKey(mediaAssetId: string, variantId: string, purpose: MediaPurpose) {
  return `${purpose}:${mediaAssetId}:variant:${variantId}`;
}

const PRIVATE_MEDIA_REFERENCE =
  /^private-media:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function clearAuthorizedMediaCache() {
  cache.clear();
}

export async function resolveAuthorizedMediaUrls(
  mediaAssetIds: Array<string | null | undefined>,
  purpose: MediaPurpose,
) {
  const ids = [...new Set(mediaAssetIds.filter((value): value is string => Boolean(value)))];
  const now = Date.now();
  const result = new Map<string, string>();
  const missing: string[] = [];
  for (const id of ids) {
    const cached = cache.get(cacheKey(id, purpose));
    if (cached && cached.expiresAt - CACHE_SAFETY_MS > now) result.set(id, cached.url);
    else missing.push(id);
  }
  if (missing.length) {
    const resolved = await getAuthorizedMediaUrls({
      data: { media_asset_ids: missing, purpose },
    });
    for (const item of resolved) {
      const entry = {
        url: item.url,
        expiresAt: Date.parse(item.expires_at),
        variantId: item.variant_id,
        variantType: item.variant_type,
      };
      cache.set(cacheKey(item.media_asset_id, purpose), entry);
      result.set(item.media_asset_id, item.url);
    }
  }
  return result;
}

export async function resolveAuthorizedMediaUrl(mediaAssetId: string, purpose: MediaPurpose) {
  return (await resolveAuthorizedMediaUrls([mediaAssetId], purpose)).get(mediaAssetId) ?? null;
}

export async function resolveAuthorizedMediaReference(
  mediaAssetId: string,
  reference: string | null | undefined,
  purpose: MediaPurpose,
) {
  if (!reference) return null;
  const match = PRIVATE_MEDIA_REFERENCE.exec(reference);
  if (!match) return reference;
  const variantId = match[1];
  const key = variantCacheKey(mediaAssetId, variantId, purpose);
  const cached = cache.get(key);
  if (cached && cached.expiresAt - CACHE_SAFETY_MS > Date.now()) return cached.url;
  const resolved = await getAuthorizedMediaVariantUrl({
    data: { media_asset_id: mediaAssetId, variant_id: variantId, purpose },
  });
  cache.set(key, {
    url: resolved.url,
    expiresAt: Date.parse(resolved.expires_at),
    variantId: resolved.variant_id,
    variantType: resolved.variant_type,
  });
  return resolved.url;
}

export async function uploadPrivateOriginal(input: {
  file: File;
  vehicleId?: string;
  bulkSessionId?: string;
  captureSessionId?: string | null;
  shotLabel?: string | null;
  sortOrder: number;
}) {
  const contentType = normalizedImageMime(input.file.type, input.file.name);
  if (!contentType) {
    throw new Error("Use a JPEG, PNG, or WebP photo up to 25 MB.");
  }
  const prepared = await preparePrivateMediaUpload({
    data: {
      vehicle_id: input.vehicleId ?? null,
      bulk_session_id: input.bulkSessionId ?? null,
      filename: input.file.name || "vehicle-photo.jpg",
      content_type: contentType,
      byte_size: input.file.size,
    },
  });
  const { error } = await supabase.storage
    .from(prepared.bucket)
    .uploadToSignedUrl(prepared.path, prepared.token, input.file, {
      contentType,
      upsert: false,
    });
  if (error) throw error;
  return finalizePrivateMediaUpload({
    data: {
      media_asset_id: prepared.media_asset_id,
      path: prepared.path,
      vehicle_id: input.vehicleId ?? null,
      bulk_session_id: input.bulkSessionId ?? null,
      capture_session_id: input.captureSessionId ?? null,
      filename: input.file.name || "vehicle-photo.jpg",
      shot_label: input.shotLabel ?? null,
      sort_order: input.sortOrder,
    },
  });
}

export async function uploadPrivateVariant(input: {
  photoId: string;
  blob: Blob;
  variantType: "cutout" | "corrected_cutout" | "customized" | "enhanced" | "dealer_render";
  processingProvider: string;
}) {
  const contentType = normalizedImageMime(input.blob.type);
  if (!contentType) throw new Error("Editor output must be JPEG, PNG, or WebP.");
  const prepared = await preparePrivateVariantUpload({
    data: {
      photo_id: input.photoId,
      variant_type: input.variantType,
      content_type: contentType,
      byte_size: input.blob.size,
    },
  });
  if (!prepared.source_variant_id) throw new Error("The source variant is unavailable.");
  const { error } = await supabase.storage
    .from(prepared.bucket)
    .uploadToSignedUrl(prepared.path, prepared.token, input.blob, {
      contentType,
      upsert: false,
    });
  if (error) throw error;
  const result = await finalizePrivateVariantUpload({
    data: {
      photo_id: input.photoId,
      media_asset_id: prepared.media_asset_id,
      variant_id: prepared.variant_id,
      source_variant_id: prepared.source_variant_id,
      variant_type: input.variantType,
      path: prepared.path,
      processing_provider: input.processingProvider,
    },
  });
  clearAuthorizedMediaCache();
  return result;
}

export async function archivePrivateMedia(mediaAssetId: string) {
  const result = await archivePrivateMediaAsset({ data: { media_asset_id: mediaAssetId } });
  clearAuthorizedMediaCache();
  return result;
}
