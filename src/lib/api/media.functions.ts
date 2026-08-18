import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import sharp from "sharp";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const PRIVATE_BUCKET = "dealer-media-private";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const allowedMime = z.enum(["image/jpeg", "image/png", "image/webp"]);
const purposeSchema = z.enum(["thumbnail", "preview", "original", "editor", "download"]);
const uuidSchema = z.string().uuid();

type UploadScope = {
  dealership_id: string;
  organization_id: string;
  vehicle_id: string | null;
  capture_session_id: string | null;
  mode: "vehicle" | "bulk";
};

type DeliveryManifest = {
  media_asset_id: string;
  dealership_id: string;
  vehicle_id: string | null;
  variant_id: string | null;
  bucket: string;
  path: string;
  content_type: string | null;
  variant_type: string;
  width: number | null;
  height: number | null;
  byte_size: number | null;
};

function safeFilename(value: string) {
  return (
    value
      .trim()
      .split("")
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join("")
      .slice(0, 255) || "vehicle-photo"
  );
}

function extensionForMime(mime: z.infer<typeof allowedMime>) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

function ttlForPurpose(purpose: z.infer<typeof purposeSchema>) {
  return purpose === "editor" || purpose === "original" ? 15 * 60 : 5 * 60;
}

function parseJsonObject<T>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The media service returned an invalid response.");
  }
  return value as T;
}

async function inspectStoredImage(path: string) {
  const { data, error } = await supabaseAdmin.storage.from(PRIVATE_BUCKET).download(path);
  if (error || !data) throw new Error(error?.message || "Uploaded media could not be verified.");
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Vehicle photos must be between 1 byte and 25 MB.");
  }
  const metadata = await sharp(bytes, { failOn: "warning" }).metadata();
  const contentType =
    metadata.format === "png"
      ? "image/png"
      : metadata.format === "webp"
        ? "image/webp"
        : metadata.format === "jpeg"
          ? "image/jpeg"
          : null;
  if (!contentType || !metadata.width || !metadata.height) {
    throw new Error("This file is not a supported JPEG, PNG, or WebP image.");
  }
  return {
    bytes,
    byteSize: bytes.length,
    width: metadata.width,
    height: metadata.height,
    contentType,
    checksum: createHash("sha256").update(bytes).digest("hex"),
  };
}

const prepareUploadInput = z
  .object({
    vehicle_id: uuidSchema.nullable().optional(),
    bulk_session_id: uuidSchema.nullable().optional(),
    filename: z.string().min(1).max(255),
    content_type: allowedMime,
    byte_size: z.number().int().min(1).max(MAX_IMAGE_BYTES),
  })
  .refine((value) => Boolean(value.vehicle_id) !== Boolean(value.bulk_session_id), {
    message: "Choose exactly one media upload target.",
  });

export const preparePrivateMediaUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => prepareUploadInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: scopeValue, error: scopeError } = await context.supabase.rpc(
      "get_media_upload_scope",
      {
        _vehicle_id: data.vehicle_id ?? undefined,
        _capture_session_id: data.bulk_session_id ?? undefined,
      },
    );
    if (scopeError) throw new Error(scopeError.message);
    const scope = parseJsonObject<UploadScope>(scopeValue);
    const mediaAssetId = randomUUID();
    const objectId = randomUUID();
    const filename = `${objectId}.${extensionForMime(data.content_type)}`;
    const path =
      scope.mode === "bulk"
        ? `stores/${scope.dealership_id}/sessions/${scope.capture_session_id}/media/${mediaAssetId}/original/${filename}`
        : `stores/${scope.dealership_id}/vehicles/${scope.vehicle_id}/media/${mediaAssetId}/original/${filename}`;
    const { data: target, error } = await supabaseAdmin.storage
      .from(PRIVATE_BUCKET)
      .createSignedUploadUrl(path, { upsert: false });
    if (error || !target?.token)
      throw new Error(error?.message || "Upload target could not be created.");
    return {
      bucket: PRIVATE_BUCKET,
      path,
      token: target.token,
      media_asset_id: mediaAssetId,
      original_filename: safeFilename(data.filename),
    };
  });

const finalizeUploadInput = z.object({
  media_asset_id: uuidSchema,
  path: z.string().min(1).max(1024),
  vehicle_id: uuidSchema.nullable().optional(),
  bulk_session_id: uuidSchema.nullable().optional(),
  capture_session_id: uuidSchema.nullable().optional(),
  filename: z.string().min(1).max(255),
  shot_label: z.string().trim().max(120).nullable().optional(),
  sort_order: z.number().int().min(0).max(10000),
});

export const finalizePrivateMediaUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => finalizeUploadInput.parse(input))
  .handler(async ({ data, context }) => {
    let inspected: Awaited<ReturnType<typeof inspectStoredImage>>;
    try {
      inspected = await inspectStoredImage(data.path);
      if (data.bulk_session_id) {
        const { data: result, error } = await supabaseAdmin.rpc("finalize_private_bulk_upload", {
          _actor_id: context.userId,
          _media_asset_id: data.media_asset_id,
          _session_id: data.bulk_session_id,
          _storage_bucket: PRIVATE_BUCKET,
          _storage_path: data.path,
          _original_filename: safeFilename(data.filename),
          _content_type: inspected.contentType,
          _byte_size: inspected.byteSize,
          _width: inspected.width,
          _height: inspected.height,
          _checksum_sha256: inspected.checksum,
          _sort_order: data.sort_order,
        });
        if (error) throw new Error(error.message);
        return parseJsonObject<Record<string, string>>(result);
      }
      if (!data.vehicle_id) throw new Error("A vehicle is required for this upload.");
      const { data: result, error } = await supabaseAdmin.rpc("finalize_private_photo_upload", {
        _actor_id: context.userId,
        _media_asset_id: data.media_asset_id,
        _vehicle_id: data.vehicle_id,
        _capture_session_id: data.capture_session_id ?? undefined,
        _storage_bucket: PRIVATE_BUCKET,
        _storage_path: data.path,
        _original_filename: safeFilename(data.filename),
        _content_type: inspected.contentType,
        _byte_size: inspected.byteSize,
        _width: inspected.width,
        _height: inspected.height,
        _checksum_sha256: inspected.checksum,
        _shot_label: data.shot_label ?? undefined,
        _sort_order: data.sort_order,
        _source_type: "capture",
      });
      if (error) throw new Error(error.message);
      return parseJsonObject<Record<string, string>>(result);
    } catch (error) {
      await supabaseAdmin.storage
        .from(PRIVATE_BUCKET)
        .remove([data.path])
        .catch(() => undefined);
      throw error;
    }
  });

const deliveryInput = z.object({
  media_asset_ids: z.array(uuidSchema).min(1).max(100),
  purpose: purposeSchema,
});

export const getAuthorizedMediaUrls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => deliveryInput.parse(input))
  .handler(async ({ data, context }) => {
    const uniqueIds = [...new Set(data.media_asset_ids)];
    const { data: manifestValue, error } = await context.supabase.rpc(
      "get_media_delivery_manifests",
      { _media_asset_ids: uniqueIds, _purpose: data.purpose },
    );
    if (error) throw new Error(error.message);
    if (!Array.isArray(manifestValue)) throw new Error("Media could not be resolved.");
    const manifests = manifestValue.map((value) => parseJsonObject<DeliveryManifest>(value));
    const expiresIn = ttlForPurpose(data.purpose);
    const urls = await Promise.all(
      manifests.map(async (manifest) => {
        const { data: signed, error: signError } = await supabaseAdmin.storage
          .from(manifest.bucket)
          .createSignedUrl(manifest.path, expiresIn, { download: data.purpose === "download" });
        if (signError || !signed?.signedUrl) {
          throw new Error(signError?.message || "Media access could not be issued.");
        }
        return {
          media_asset_id: manifest.media_asset_id,
          variant_id: manifest.variant_id,
          variant_type: manifest.variant_type,
          url: signed.signedUrl,
          expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        };
      }),
    );
    return urls;
  });

const variantDeliveryInput = z.object({
  media_asset_id: uuidSchema,
  variant_id: uuidSchema,
  purpose: purposeSchema,
});

export const getAuthorizedMediaVariantUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => variantDeliveryInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: manifestValue, error } = await context.supabase.rpc(
      "get_media_delivery_manifest",
      {
        _media_asset_id: data.media_asset_id,
        _purpose: data.purpose,
        _variant_id: data.variant_id,
      },
    );
    if (error) throw new Error(error.message);
    const manifest = parseJsonObject<DeliveryManifest>(manifestValue);
    const expiresIn = ttlForPurpose(data.purpose);
    const { data: signed, error: signError } = await supabaseAdmin.storage
      .from(manifest.bucket)
      .createSignedUrl(manifest.path, expiresIn, { download: data.purpose === "download" });
    if (signError || !signed?.signedUrl) {
      throw new Error(signError?.message || "Media access could not be issued.");
    }
    return {
      media_asset_id: manifest.media_asset_id,
      variant_id: manifest.variant_id,
      variant_type: manifest.variant_type,
      url: signed.signedUrl,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  });

const prepareVariantInput = z.object({
  photo_id: uuidSchema,
  variant_type: z.enum(["cutout", "corrected_cutout", "customized", "enhanced", "dealer_render"]),
  content_type: allowedMime,
  byte_size: z.number().int().min(1).max(MAX_IMAGE_BYTES),
});

export const preparePrivateVariantUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => prepareVariantInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: photo, error: photoError } = await context.supabase
      .from("photos")
      .select("id, vehicle_id, media_asset_id, approved_variant_id")
      .eq("id", data.photo_id)
      .maybeSingle();
    if (photoError || !photo?.media_asset_id)
      throw new Error(photoError?.message || "Photo not found.");
    const { data: manifestValue, error: manifestError } = await context.supabase.rpc(
      "get_media_delivery_manifest",
      { _media_asset_id: photo.media_asset_id, _purpose: "editor" },
    );
    if (manifestError) throw new Error(manifestError.message);
    const manifest = parseJsonObject<DeliveryManifest>(manifestValue);
    const variantId = randomUUID();
    const path = `stores/${manifest.dealership_id}/vehicles/${photo.vehicle_id}/media/${photo.media_asset_id}/variants/${data.variant_type}/${variantId}.${extensionForMime(data.content_type)}`;
    const { data: target, error } = await supabaseAdmin.storage
      .from(PRIVATE_BUCKET)
      .createSignedUploadUrl(path, { upsert: false });
    if (error || !target?.token)
      throw new Error(error?.message || "Variant upload target could not be created.");
    return {
      bucket: PRIVATE_BUCKET,
      path,
      token: target.token,
      variant_id: variantId,
      media_asset_id: photo.media_asset_id,
      source_variant_id: photo.approved_variant_id ?? manifest.variant_id,
    };
  });

const finalizeVariantInput = z.object({
  photo_id: uuidSchema,
  media_asset_id: uuidSchema,
  variant_id: uuidSchema,
  source_variant_id: uuidSchema,
  variant_type: z.enum(["cutout", "corrected_cutout", "customized", "enhanced", "dealer_render"]),
  path: z.string().min(1).max(1024),
  processing_provider: z.string().trim().min(1).max(120),
});

export const finalizePrivateVariantUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => finalizeVariantInput.parse(input))
  .handler(async ({ data, context }) => {
    try {
      const inspected = await inspectStoredImage(data.path);
      const { data: result, error } = await supabaseAdmin.rpc("commit_private_photo_variant", {
        _actor_id: context.userId,
        _photo_id: data.photo_id,
        _variant_id: data.variant_id,
        _variant_type: data.variant_type,
        _source_variant_id: data.source_variant_id,
        _storage_bucket: PRIVATE_BUCKET,
        _storage_path: data.path,
        _content_type: inspected.contentType,
        _byte_size: inspected.byteSize,
        _width: inspected.width,
        _height: inspected.height,
        _checksum_sha256: inspected.checksum,
        _processing_provider: data.processing_provider,
      });
      if (error) throw new Error(error.message);
      return parseJsonObject<Record<string, string>>(result);
    } catch (error) {
      await supabaseAdmin.storage
        .from(PRIVATE_BUCKET)
        .remove([data.path])
        .catch(() => undefined);
      throw error;
    }
  });

export const archivePrivateMediaAsset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ media_asset_id: uuidSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: archived, error } = await supabaseAdmin.rpc("archive_private_media_asset", {
      _actor_id: context.userId,
      _media_asset_id: data.media_asset_id,
    });
    if (error) throw new Error(error.message);
    if (!archived) throw new Error("Media was not found.");
    return { archived: true };
  });
