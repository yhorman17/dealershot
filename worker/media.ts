import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";

import type { Database, Json } from "../src/integrations/supabase/types";
import type { BackgroundJob, JobHandler } from "./runtime";

const PRIVATE_BUCKET = "dealer-media-private";
const LEGACY_PRIVATE_BUCKET = "dealer-media-legacy-private";
const LEGACY_BUCKET = "vehicle-photos";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

type MigrationRecord = {
  migration_id: string;
  media_asset_id: string;
  media_variant_id: string;
  source_bucket: string;
  source_path: string;
  destination_bucket: string;
  destination_path: string;
  state: string;
  variant_type: string;
  dealership_id: string;
  vehicle_id: string | null;
};

type MediaSource = {
  media_asset_id: string;
  dealership_id: string;
  vehicle_id: string | null;
  bucket: string;
  path: string;
  photo_id: string | null;
  source_variant_id: string;
  content_type: string;
};

function asObject<T>(value: Json | null): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_media_job_payload");
  }
  return value as T;
}

function payloadId(job: BackgroundJob, key: string) {
  const value = job.payload[key];
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error("invalid_media_job_payload");
  }
  return value;
}

function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function imageMetadata(bytes: Buffer, allowLegacySvg = false) {
  if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) throw new Error("invalid_media_size");
  const metadata = await sharp(bytes, { failOn: "warning" }).metadata();
  const contentType =
    metadata.format === "png"
      ? "image/png"
      : metadata.format === "webp"
        ? "image/webp"
        : metadata.format === "jpeg"
          ? "image/jpeg"
          : allowLegacySvg && metadata.format === "svg"
            ? "image/svg+xml"
            : null;
  if (!contentType || !metadata.width || !metadata.height)
    throw new Error("unsupported_media_type");
  return {
    contentType,
    storageContentType: contentType === "image/svg+xml" ? "application/octet-stream" : contentType,
    width: metadata.width,
    height: metadata.height,
  };
}

async function downloadBytes(client: SupabaseClient<Database>, bucket: string, path: string) {
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) throw new Error("storage_download_failed");
  return Buffer.from(await data.arrayBuffer());
}

async function uploadVerified(
  client: SupabaseClient<Database>,
  bucket: string,
  path: string,
  bytes: Buffer,
  contentType: string,
) {
  const { error } = await client.storage.from(bucket).upload(path, bytes, {
    contentType,
    upsert: false,
    cacheControl: "31536000",
  });
  if (error && !/already exists|duplicate/i.test(error.message))
    throw new Error("storage_upload_failed");
  const destination = await downloadBytes(client, bucket, path);
  if (destination.length !== bytes.length || hash(destination) !== hash(bytes)) {
    throw new Error("storage_verification_failed");
  }
}

export async function ensurePrivateMediaBucket(client: SupabaseClient<Database>) {
  const { data: buckets, error } = await client.storage.listBuckets();
  if (error) throw new Error("storage_bucket_list_failed");
  if (!buckets.some((bucket) => bucket.id === PRIVATE_BUCKET)) {
    const { error: createError } = await client.storage.createBucket(PRIVATE_BUCKET, {
      public: false,
      fileSizeLimit: MAX_IMAGE_BYTES,
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    });
    if (createError) throw new Error("storage_bucket_create_failed");
  } else {
    const { error: updateError } = await client.storage.updateBucket(PRIVATE_BUCKET, {
      public: false,
      fileSizeLimit: MAX_IMAGE_BYTES,
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    });
    if (updateError) throw new Error("storage_bucket_update_failed");
  }
  if (!buckets.some((bucket) => bucket.id === LEGACY_PRIVATE_BUCKET)) {
    const { error: createError } = await client.storage.createBucket(LEGACY_PRIVATE_BUCKET, {
      public: false,
      fileSizeLimit: MAX_IMAGE_BYTES,
      allowedMimeTypes: ["application/octet-stream"],
    });
    if (createError) throw new Error("legacy_storage_bucket_create_failed");
  } else {
    const { error: updateError } = await client.storage.updateBucket(LEGACY_PRIVATE_BUCKET, {
      public: false,
      fileSizeLimit: MAX_IMAGE_BYTES,
      allowedMimeTypes: ["application/octet-stream"],
    });
    if (updateError) throw new Error("legacy_storage_bucket_update_failed");
  }
}

async function migrateLegacyMedia(client: SupabaseClient<Database>, job: BackgroundJob) {
  const migrationId = payloadId(job, "migration_id");
  const { data, error } = await client.rpc("worker_get_media_migration", {
    _migration_id: migrationId,
  });
  if (error) throw new Error("migration_lookup_failed");
  const migration = asObject<MigrationRecord>(data);
  if (migration.state === "private") return { already_verified: true };
  try {
    const source = await downloadBytes(client, migration.source_bucket, migration.source_path);
    const metadata = await imageMetadata(
      source,
      migration.destination_bucket === LEGACY_PRIVATE_BUCKET,
    );
    await uploadVerified(
      client,
      migration.destination_bucket,
      migration.destination_path,
      source,
      metadata.storageContentType,
    );
    const checksum = hash(source);
    const completionRpc =
      metadata.contentType === "image/svg+xml"
        ? "worker_complete_legacy_svg_migration"
        : "worker_complete_media_migration";
    const { data: completed, error: completeError } = await client.rpc(completionRpc, {
      _migration_id: migrationId,
      _checksum_sha256: checksum,
      _byte_size: source.length,
      _content_type: metadata.contentType,
      _width: metadata.width,
      _height: metadata.height,
    });
    if (completeError || completed !== true) throw new Error("migration_finalize_failed");
    return { migrated: true, bytes: source.length, checksum_prefix: checksum.slice(0, 12) };
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "migration_failed";
    await client.rpc("worker_fail_media_migration", {
      _migration_id: migrationId,
      _safe_error_code: code,
    });
    throw cause;
  }
}

async function generateThumbnails(client: SupabaseClient<Database>, job: BackgroundJob) {
  const mediaAssetId = payloadId(job, "media_asset_id");
  const { data, error } = await client.rpc("worker_get_media_asset_source", {
    _media_asset_id: mediaAssetId,
  });
  if (error) throw new Error("media_source_lookup_failed");
  const source = asObject<MediaSource>(data);
  const original = await downloadBytes(client, source.bucket, source.path);
  await imageMetadata(original, source.content_type === "image/svg+xml");
  const base = source.path.includes("/original/")
    ? source.path.slice(0, source.path.indexOf("/original/"))
    : source.path.replace(/\/[^/]+$/, "");
  const derivatives = [
    {
      type: "thumbnail",
      role: "thumbnail_small",
      width: 320,
      quality: 78,
      name: "thumbnail-320.webp",
    },
    { type: "preview", role: "preview", width: 1280, quality: 82, name: "preview-1280.webp" },
  ] as const;
  const outputs: Array<{ role: string; bytes: number }> = [];
  for (const derivative of derivatives) {
    const bytes = await sharp(original)
      .rotate()
      .resize({ width: derivative.width, withoutEnlargement: true, fit: "inside" })
      .webp({ quality: derivative.quality, effort: 4 })
      .toBuffer();
    const metadata = await sharp(bytes).metadata();
    const path = `${base}/derivatives/${derivative.name}`;
    await uploadVerified(client, PRIVATE_BUCKET, path, bytes, "image/webp");
    const { error: registerError } = await client.rpc("worker_register_media_derivative", {
      _media_asset_id: mediaAssetId,
      _variant_type: derivative.type,
      _variant_role: derivative.role,
      _storage_bucket: PRIVATE_BUCKET,
      _storage_path: path,
      _content_type: "image/webp",
      _byte_size: bytes.length,
      _width: metadata.width ?? derivative.width,
      _height: metadata.height ?? 1,
      _checksum_sha256: hash(bytes),
      _processing_provider: "dealershot-sharp",
      _metadata: { exif_stripped: true, quality: derivative.quality },
    });
    if (registerError) throw new Error("derivative_register_failed");
    outputs.push({ role: derivative.role, bytes: bytes.length });
  }
  return { media_asset_id: mediaAssetId, derivatives: outputs };
}

async function lockdownLegacyBucket(client: SupabaseClient<Database>) {
  const { data, error } = await client.rpc("worker_get_media_migration_status");
  if (error) throw new Error("migration_status_failed");
  const status = asObject<{ total: number; private: number; failed: number; pending: number }>(
    data,
  );
  if (Number(status.failed) > 0) throw new Error("migration_failures_present");
  if (Number(status.pending) > 0 || Number(status.private) !== Number(status.total)) {
    throw new Error("migration_not_complete");
  }
  const { error: updateError } = await client.storage.updateBucket(LEGACY_BUCKET, {
    public: false,
  });
  if (updateError) throw new Error("legacy_bucket_lockdown_failed");
  return { legacy_bucket_private: true, migrated: status.private };
}

export function createMediaJobHandlers(
  client: SupabaseClient<Database>,
): Record<string, JobHandler> {
  return {
    "media.legacy.migrate": (job) => migrateLegacyMedia(client, job),
    "media.thumbnail.generate": (job) => generateThumbnails(client, job),
    "media.legacy.lockdown": () => lockdownLegacyBucket(client),
  };
}
