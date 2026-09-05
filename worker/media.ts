import { createHash, randomUUID } from "node:crypto";
import { access, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp, { type OutputInfo } from "sharp";

import type { Database, Json } from "../src/integrations/supabase/types";
import type { BackgroundJob, JobHandler } from "./runtime";
import {
  analyzeBackgroundMask,
  BackgroundProcessingError,
  type MaskQuality,
  type SafeMaskDiagnostics,
} from "./background-removal-diagnostics.ts";
import {
  createVehicleAwareCutout,
  VEHICLE_AWARE_PIPELINE_VERSION,
  type VehicleAwareCutoutResult,
} from "./vehicle-aware-cutout.ts";
import { runVehicleSegmentationV3Isolated } from "./vehicle-segmentation-v3-isolated.ts";
import { composeDefaultProcessedPhoto } from "./default-backdrop-composition.ts";
import { PREPARED_IMAGE_HEIGHT, PREPARED_IMAGE_WIDTH } from "../src/lib/vehicle-ground-effects.ts";

const PRIVATE_BUCKET = "dealer-media-private";
const LEGACY_PRIVATE_BUCKET = "dealer-media-legacy-private";
const LEGACY_BUCKET = "vehicle-photos";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const SEGMENTATION_SIZE = 1024;
const BACKGROUND_REMOVAL_MODEL_KEY = "/models/isnet_quint8";

export function vehicleSegmentationV3RolloutEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  // V3 remains available for controlled review experiments, but one stale
  // deployment flag must never replace the production remover by itself.
  return (
    environment.VEHICLE_SEGMENTATION_V3?.trim() === "1" &&
    environment.VEHICLE_SEGMENTATION_V3_REVIEW_ROLLOUT?.trim() === "1"
  );
}

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

type VehicleDeletionOperation = {
  operation_id: string;
  vehicle_id: string;
  storage_status: "queued" | "running" | "succeeded" | "failed";
  storage_manifest: Array<{ bucket: string; path: string }>;
};

type BackgroundRemovalSource = {
  job_id: string;
  actor_id: string;
  media_asset_id: string;
  dealership_id: string;
  vehicle_id: string;
  photo_id: string;
  source_variant_id: string;
  bucket: string;
  path: string;
  content_type: string;
  shot_type: string | null;
  default_backdrop_id: string | null;
  default_backdrop_bucket: string | null;
  default_backdrop_path: string | null;
};

type BackgroundRemovalManifest = Record<
  string,
  {
    size: number;
    chunks: Array<{ name: string; hash: string; offsets: [number, number] }>;
  }
>;

type OnnxRuntime = typeof import("onnxruntime-node");
let backgroundRemovalRuntime: Promise<{
  ort: OnnxRuntime;
  session: import("onnxruntime-node").InferenceSession;
  inputName: string;
  outputName: string;
  inputShape: ReadonlyArray<number | string>;
  outputShape: ReadonlyArray<number | string>;
}> | null = null;

const VEHICLE_DELETE_BUCKETS = new Set([
  "dealer-media-private",
  "dealer-media-legacy-private",
  "vehicle-photos",
  "documents",
]);

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

function safeExceptionName(error: unknown) {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(error.name)
    ? error.name
    : "UnknownError";
}

function runtimeImportFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const code =
    message.includes("Could not dynamically require") &&
    message.includes("onnxruntime_binding.node")
      ? "background_worker_bundle_native_import_failed"
      : message.includes("onnxruntime_binding.node")
        ? "background_native_binding_load_failed"
        : "background_runtime_unavailable";
  return new BackgroundProcessingError(code, "resource_failure", false, {
    stage: "runtime_import",
    exception_name: safeExceptionName(error),
    platform: process.platform,
    architecture: process.arch,
    node_major: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10),
  });
}

async function backgroundRemovalAssetDirectory() {
  const candidates = [
    path.resolve(process.cwd(), ".output/public/background-removal"),
    path.resolve(process.cwd(), "public/background-removal"),
  ];
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "resources.json"));
      return candidate;
    } catch {
      // Production serves verified model chunks from .output; source is a local test fallback.
    }
  }
  throw new Error("background_model_unavailable");
}

async function loadBackgroundRemovalModel() {
  const directory = await backgroundRemovalAssetDirectory();
  const manifest = JSON.parse(
    await readFile(path.join(directory, "resources.json"), "utf8"),
  ) as BackgroundRemovalManifest;
  const resource = manifest[BACKGROUND_REMOVAL_MODEL_KEY];
  if (!resource || !Number.isSafeInteger(resource.size) || !Array.isArray(resource.chunks)) {
    throw new Error("background_model_manifest_invalid");
  }
  const modelPath = path.join(os.tmpdir(), `dealershot-isnet-${process.pid}-${randomUUID()}.onnx`);
  const partialPath = `${modelPath}.partial`;
  const output = await open(partialPath, "wx", 0o600);
  let total = 0;
  let outputClosed = false;
  try {
    for (const chunk of resource.chunks) {
      if (!/^[a-f0-9]{64}$/.test(chunk.name) || chunk.hash !== chunk.name) {
        throw new Error("background_model_manifest_invalid");
      }
      const bytes = await readFile(path.join(directory, chunk.name));
      if (hash(bytes) !== chunk.hash || chunk.offsets[0] !== total) {
        throw new Error("background_model_integrity_failed");
      }
      const { bytesWritten } = await output.write(bytes, 0, bytes.length, total);
      if (bytesWritten !== bytes.length) throw new Error("background_model_write_failed");
      total += bytes.length;
      if (chunk.offsets[1] !== total) throw new Error("background_model_integrity_failed");
    }
    if (total !== resource.size) throw new Error("background_model_integrity_failed");
    await output.sync();
    await output.close();
    outputClosed = true;
    await rename(partialPath, modelPath);
    return modelPath;
  } catch (error) {
    if (!outputClosed) await output.close().catch(() => undefined);
    await rm(partialPath, { force: true }).catch(() => undefined);
    await rm(modelPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function getBackgroundRemovalRuntime() {
  backgroundRemovalRuntime ??= (async () => {
    let ort: OnnxRuntime;
    let modelPath: string;
    try {
      [ort, modelPath] = await Promise.all([
        import("onnxruntime-node"),
        loadBackgroundRemovalModel(),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("background_model_")) {
        throw new BackgroundProcessingError(error.message, "resource_failure", false, {
          stage: "model_artifact_load",
        });
      }
      throw runtimeImportFailure(error);
    }
    try {
      let session: import("onnxruntime-node").InferenceSession;
      try {
        session = await ort.InferenceSession.create(modelPath, {
          executionProviders: ["cpu"],
          // Graph rewriting creates a large transient native-memory spike while
          // ISNet is initialized. The worker processes one image at a time, so
          // disable it and favor a predictable memory ceiling over warm-up speed.
          graphOptimizationLevel: "disabled",
          // The hosted worker has a strict memory ceiling. ISNet is processed by
          // one durable job at a time, so parallel execution and retained CPU
          // arenas add memory without increasing queue throughput.
          executionMode: "sequential",
          enableCpuMemArena: false,
          enableMemPattern: false,
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
        });
      } finally {
        // ONNX Runtime has loaded the verified model. Removing the temporary
        // assembly avoids retaining another 56 MiB file in the container/image.
        await rm(modelPath, { force: true }).catch(() => undefined);
      }
      const inputName = session.inputNames[0];
      const outputName = session.outputNames[0];
      const inputMetadata = session.inputMetadata[0];
      const outputMetadata = session.outputMetadata[0];
      const inputShape = inputMetadata?.isTensor ? inputMetadata.shape : [];
      const outputShape = outputMetadata?.isTensor ? outputMetadata.shape : [];
      const expectedInputShape = [1, 3, SEGMENTATION_SIZE, SEGMENTATION_SIZE];
      const expectedOutputShape = [1, 1, SEGMENTATION_SIZE, SEGMENTATION_SIZE];
      if (
        session.inputNames.length !== 1 ||
        session.outputNames.length !== 1 ||
        !inputName ||
        !outputName ||
        JSON.stringify(inputShape) !== JSON.stringify(expectedInputShape) ||
        JSON.stringify(outputShape) !== JSON.stringify(expectedOutputShape)
      ) {
        throw new BackgroundProcessingError(
          "background_model_contract_invalid",
          "resource_failure",
          false,
          {
            stage: "model_contract",
            input_count: session.inputNames.length,
            output_count: session.outputNames.length,
            input_shape: [...inputShape],
            output_shape: [...outputShape],
          },
        );
      }
      return { ort, session, inputName, outputName, inputShape, outputShape };
    } catch (error) {
      if (error instanceof BackgroundProcessingError) throw error;
      throw new BackgroundProcessingError(
        "background_model_initialization_failed",
        "resource_failure",
        false,
        { stage: "model_initialization", exception_name: safeExceptionName(error) },
      );
    }
  })().catch((error) => {
    // Never pin a rejected initialization promise for the life of the worker.
    // A replacement deployment or repaired asset should be able to initialize.
    backgroundRemovalRuntime = null;
    throw error;
  });
  return backgroundRemovalRuntime;
}

export async function createTransparentVehicleCutoutResult(original: Buffer) {
  let normalized: Buffer;
  let normalizedInfo: OutputInfo;
  try {
    const result = await sharp(original, { failOn: "warning" })
      .rotate()
      .removeAlpha()
      // IMG.LY's in-editor ISNet path uses bilinear input resampling. Keep the
      // durable worker on the same preprocessing contract so automatic and
      // manually-created cutouts do not diverge before inference.
      .resize(SEGMENTATION_SIZE, SEGMENTATION_SIZE, { fit: "fill", kernel: "linear" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    normalized = result.data;
    normalizedInfo = result.info;
  } catch {
    throw new BackgroundProcessingError("background_source_decode_failed", "source_invalid", false);
  }
  if (normalizedInfo.channels !== 3) throw new Error("background_source_decode_failed");

  const stride = SEGMENTATION_SIZE * SEGMENTATION_SIZE;
  const input = new Float32Array(stride * 3);
  for (let pixel = 0; pixel < stride; pixel += 1) {
    const source = pixel * 3;
    input[pixel] = (normalized[source] - 128) / 256;
    input[pixel + stride] = (normalized[source + 1] - 128) / 256;
    input[pixel + stride * 2] = (normalized[source + 2] - 128) / 256;
  }

  if (input.length !== 1 * 3 * SEGMENTATION_SIZE * SEGMENTATION_SIZE) {
    throw new BackgroundProcessingError(
      "background_input_tensor_invalid",
      "resource_failure",
      false,
      { stage: "tensor_preparation", tensor_elements: input.length },
    );
  }

  const { ort, session, inputName, outputName, inputShape, outputShape } =
    await getBackgroundRemovalRuntime();
  const runStartedAt = performance.now();
  const rssBefore = process.memoryUsage().rss;
  let mask: Buffer;
  let minimum = 255;
  let maximum = 0;
  let outputElements = 0;
  let releaseFailure: BackgroundProcessingError | null = null;
  try {
    const outputs = await (async () => {
      try {
        return await session.run({
          [inputName]: new ort.Tensor("float32", input, [
            1,
            3,
            SEGMENTATION_SIZE,
            SEGMENTATION_SIZE,
          ]),
        });
      } catch (error) {
        throw new BackgroundProcessingError(
          "background_inference_runtime_failed",
          "resource_failure",
          false,
          {
            stage: "session_run",
            exception_name: safeExceptionName(error),
            input_name: inputName,
            input_shape: [...inputShape],
            tensor_elements: input.length,
          },
        );
      }
    })();
    const prediction = outputs[outputName];
    if (!prediction || prediction.data.length !== stride) {
      throw new BackgroundProcessingError(
        "background_inference_output_invalid",
        "resource_failure",
        false,
        {
          stage: "output_tensor",
          output_name: outputName,
          output_shape: [...outputShape],
          output_elements: prediction?.data.length ?? 0,
          expected_elements: stride,
        },
      );
    }
    outputElements = prediction.data.length;
    mask = Buffer.allocUnsafe(stride);
    for (let index = 0; index < stride; index += 1) {
      const value = Math.max(0, Math.min(255, Math.round(Number(prediction.data[index]) * 255)));
      mask[index] = value;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  } finally {
    try {
      await session.release();
    } catch (error) {
      releaseFailure = new BackgroundProcessingError(
        "background_runtime_release_failed",
        "resource_failure",
        false,
        {
          stage: "session_release",
          exception_name: safeExceptionName(error),
        },
      );
    } finally {
      // The worker handles one durable job at a time. Releasing the large
      // native session before full-resolution RGBA composition prevents the
      // inference and image-encoding peaks from stacking in a 1 GiB process.
      backgroundRemovalRuntime = null;
    }
  }
  if (releaseFailure) throw releaseFailure;
  const runDurationMs = Math.round(performance.now() - runStartedAt);
  const rssAfter = process.memoryUsage().rss;
  const modelMaskResult = analyzeBackgroundMask(mask, SEGMENTATION_SIZE, SEGMENTATION_SIZE);
  if (
    minimum === maximum ||
    (modelMaskResult.quality === "bad" && !modelMaskResult.diagnostics.draft_usable)
  ) {
    throw new BackgroundProcessingError(
      "background_inference_mask_invalid",
      "model_rejection",
      false,
      modelMaskResult.diagnostics,
    );
  }

  let sourcePixels: Buffer;
  let info: OutputInfo;
  try {
    const decoded = await sharp(original, { failOn: "warning" })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    sourcePixels = decoded.data;
    info = decoded.info;
  } catch {
    throw new BackgroundProcessingError("background_source_decode_failed", "source_invalid", false);
  }
  const resizedAlpha = await sharp(mask, {
    raw: { width: SEGMENTATION_SIZE, height: SEGMENTATION_SIZE, channels: 1 },
  })
    .resize(info.width, info.height, { fit: "fill", kernel: "linear" })
    // Sharp promotes a one-channel raw resize to sRGB unless grayscale output
    // is requested explicitly. Reading that three-channel buffer as one alpha
    // plane produced scan-lined, spatially corrupt automatic cutouts.
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (resizedAlpha.info.channels !== 1 || resizedAlpha.data.length !== info.width * info.height) {
    throw new BackgroundProcessingError(
      "background_output_alpha_contract_invalid",
      "resource_failure",
      false,
      {
        stage: "alpha_resample",
        alpha_channels: resizedAlpha.info.channels,
        alpha_elements: resizedAlpha.data.length,
        expected_elements: info.width * info.height,
      },
    );
  }
  const outputMaskResult = analyzeBackgroundMask(resizedAlpha.data, info.width, info.height);
  const qualityRank: Record<MaskQuality, number> = { good: 0, needs_review: 1, bad: 2 };
  const quality =
    qualityRank[modelMaskResult.quality] >= qualityRank[outputMaskResult.quality]
      ? modelMaskResult.quality
      : outputMaskResult.quality;
  const diagnostics: SafeMaskDiagnostics = {
    ...outputMaskResult.diagnostics,
    reasons: [
      ...new Set([...modelMaskResult.diagnostics.reasons, ...outputMaskResult.diagnostics.reasons]),
    ],
    draft_usable:
      modelMaskResult.diagnostics.draft_usable && outputMaskResult.diagnostics.draft_usable,
  };
  if (quality === "bad" && !diagnostics.draft_usable) {
    throw new BackgroundProcessingError(
      "background_output_mask_invalid",
      "model_rejection",
      false,
      diagnostics,
    );
  }
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    sourcePixels[pixel * 4 + 3] = resizedAlpha.data[pixel];
  }
  try {
    const bytes = await sharp(sourcePixels, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return {
      bytes,
      quality,
      diagnostics,
      inference: {
        model: "isnet_quint8",
        input_name: inputName,
        input_shape: [...inputShape],
        tensor_elements: input.length,
        output_name: outputName,
        output_shape: [...outputShape],
        output_elements: outputElements,
        session_run_ms: runDurationMs,
        rss_before_mib: Math.round((rssBefore / 1024 / 1024) * 10) / 10,
        rss_after_mib: Math.round((rssAfter / 1024 / 1024) * 10) / 10,
        model_mask_quality: modelMaskResult.quality,
        output_mask_quality: outputMaskResult.quality,
        output_alpha_channels: resizedAlpha.info.channels,
      },
    };
  } catch {
    throw new BackgroundProcessingError(
      "background_output_encode_failed",
      "resource_failure",
      false,
    );
  }
}

export async function createTransparentVehicleCutout(original: Buffer) {
  return (await createTransparentVehicleCutoutResult(original)).bytes;
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

async function removeMediaBackground(client: SupabaseClient<Database>, job: BackgroundJob) {
  const { data, error } = await client.rpc(
    "worker_get_background_removal_source" as never,
    { _job_id: job.job_id } as never,
  );
  if (error) throw new Error("background_source_lookup_failed");
  const source = asObject<BackgroundRemovalSource>(data as Json | null);
  const original = await downloadBytes(client, source.bucket, source.path);
  await imageMetadata(original);

  let bytes: Buffer;
  let vehicleAware: VehicleAwareCutoutResult | null = null;
  let standardQuality: MaskQuality = "good";
  let standardDiagnostics: SafeMaskDiagnostics | null = null;
  let standardInference: Record<string, unknown> | null = null;
  let vehicleSegmentationV3: Awaited<ReturnType<typeof runVehicleSegmentationV3Isolated>> | null =
    null;
  let vehicleSegmentationV3Diagnostics: Record<string, unknown> | null = null;
  const vehicleSegmentationV3Enabled = vehicleSegmentationV3RolloutEnabled();
  const vehicleAwareEnabled = process.env.VEHICLE_AWARE_BACKGROUND_REMOVAL?.trim() === "1";
  if (vehicleSegmentationV3Enabled) {
    try {
      vehicleSegmentationV3 = await runVehicleSegmentationV3Isolated(original);
    } catch (error) {
      throw new BackgroundProcessingError(
        "vehicle_segmentation_v3_runtime_failed",
        "resource_failure",
        false,
        { stage: "vehicle_segmentation_v3", exception_name: safeExceptionName(error) },
      );
    }
    if (!vehicleSegmentationV3.bytes) {
      throw new BackgroundProcessingError(
        "vehicle_segmentation_v3_vehicle_ineligible",
        "model_rejection",
        false,
        {
          stage: "full_vehicle_validation",
          eligibility: vehicleSegmentationV3.eligibility.classification,
          reasons: vehicleSegmentationV3.eligibility.reasons,
        },
      );
    }
    bytes = vehicleSegmentationV3.bytes;
    // V3 is materially better on dealership vehicles, but this is a controlled
    // review-first rollout. The derivative remains a draft until a user approves
    // or corrects it through Fix Cutout; the immutable original stays current.
    standardQuality = "needs_review";
    vehicleSegmentationV3Diagnostics = {
      eligibility: vehicleSegmentationV3.eligibility,
      selected_vehicle: vehicleSegmentationV3.selected,
      candidate_count: vehicleSegmentationV3.candidateCount,
      ambiguous: vehicleSegmentationV3.ambiguous,
      model_quality: vehicleSegmentationV3.quality,
      memory: vehicleSegmentationV3.memory,
      rollout_policy: "review_required",
    };
    standardInference = {
      pipeline: vehicleSegmentationV3.metadata.pipeline,
      detector: vehicleSegmentationV3.metadata.detector,
      segmenter: vehicleSegmentationV3.metadata.segmenter,
      method: vehicleSegmentationV3.metadata.method,
    };
  } else if (vehicleAwareEnabled) {
    try {
      vehicleAware = await createVehicleAwareCutout(original, createTransparentVehicleCutout);
      bytes = vehicleAware.bytes;
    } catch {
      const fallback = await createTransparentVehicleCutoutResult(original);
      bytes = fallback.bytes;
      vehicleAware = {
        bytes,
        method: "standard_fallback",
        detector: {
          model: "unavailable",
          selected: null,
          candidateCount: 0,
          ambiguous: false,
        },
        roi: null,
        quality: {
          rating: "bad",
          score: 0,
          reasons: ["vehicle_aware_pipeline_failed"],
          metrics: {
            detectorConfidence: 0,
            detectorMaskCoverage: 0,
            maskBoxCoverage: 0,
            primaryComponentRatio: 0,
            centerOccupancy: 0,
            edgeContactRatio: 0,
            enclosedHoleRatio: 0,
            ambiguous: false,
          },
        },
        framing: null,
      };
    }
  } else {
    const standard = await createTransparentVehicleCutoutResult(original);
    bytes = standard.bytes;
    standardQuality = standard.quality;
    standardDiagnostics = standard.diagnostics;
    standardInference = standard.inference;
  }
  const metadata = await sharp(bytes, { failOn: "warning" }).metadata();
  if (
    metadata.format !== "png" ||
    !metadata.width ||
    !metadata.height ||
    !metadata.hasAlpha ||
    bytes.length < 1 ||
    bytes.length > MAX_IMAGE_BYTES
  ) {
    throw new Error("background_output_invalid");
  }

  // Cancellation is cooperative: inference may already have finished, but a
  // canceled request must never write or promote a new derivative.
  const { data: activeSource, error: activeSourceError } = await client.rpc(
    "worker_get_background_removal_source" as never,
    { _job_id: job.job_id } as never,
  );
  if (activeSourceError || !activeSource) throw new Error("background_processing_cancelled");

  const variantId = randomUUID();
  const path = `stores/${source.dealership_id}/vehicles/${source.vehicle_id}/media/${source.media_asset_id}/variants/cutout/${job.job_id}-${variantId}.png`;
  await uploadVerified(client, PRIVATE_BUCKET, path, bytes, "image/png");
  let prepared: {
    variantId: string;
    path: string;
    bytes: Buffer;
    metadata: Awaited<ReturnType<typeof composeDefaultProcessedPhoto>>;
  } | null = null;
  let preparedCandidatePath: string | null = null;
  if (
    !vehicleSegmentationV3 &&
    !vehicleAware &&
    standardQuality === "good" &&
    source.default_backdrop_id &&
    source.default_backdrop_bucket === "backdrops" &&
    source.default_backdrop_path
  ) {
    try {
      const backdrop = await downloadBytes(
        client,
        source.default_backdrop_bucket,
        source.default_backdrop_path,
      );
      const composed = await composeDefaultProcessedPhoto({
        cutout: bytes,
        backdrop,
        shotType: source.shot_type,
      });
      const preparedVariantId = randomUUID();
      const preparedPath = `stores/${source.dealership_id}/vehicles/${source.vehicle_id}/media/${source.media_asset_id}/variants/customized/${job.job_id}-${preparedVariantId}.jpg`;
      preparedCandidatePath = preparedPath;
      await uploadVerified(client, PRIVATE_BUCKET, preparedPath, composed.bytes, "image/jpeg");
      prepared = {
        variantId: preparedVariantId,
        path: preparedPath,
        bytes: composed.bytes,
        metadata: composed,
      };
    } catch (error) {
      await client.storage
        .from(PRIVATE_BUCKET)
        .remove(preparedCandidatePath ? [path, preparedCandidatePath] : [path])
        .catch(() => undefined);
      throw new BackgroundProcessingError(
        "default_backdrop_composition_failed",
        "finalization_failure",
        true,
        { stage: "default_backdrop_composition", exception_name: safeExceptionName(error) },
      );
    }
  }

  const commitRpc = prepared
    ? "worker_commit_background_cutout_and_default_composition"
    : vehicleSegmentationV3
      ? "worker_commit_vehicle_segmentation_v3_review"
      : vehicleAware
        ? "worker_commit_vehicle_aware_cutout"
        : "worker_commit_background_cutout_result";
  const commitArguments = {
    _job_id: job.job_id,
    _variant_id: variantId,
    _storage_bucket: PRIVATE_BUCKET,
    _storage_path: path,
    _byte_size: bytes.length,
    _width: metadata.width,
    _height: metadata.height,
    _checksum_sha256: hash(bytes),
    ...(prepared
      ? {
          _quality_class: standardQuality,
          _diagnostics: standardDiagnostics,
          _prepared_variant_id: prepared.variantId,
          _prepared_storage_bucket: PRIVATE_BUCKET,
          _prepared_storage_path: prepared.path,
          _prepared_byte_size: prepared.bytes.length,
          _prepared_width: PREPARED_IMAGE_WIDTH,
          _prepared_height: PREPARED_IMAGE_HEIGHT,
          _prepared_checksum_sha256: hash(prepared.bytes),
          _backdrop_id: source.default_backdrop_id,
          _composition_metadata: {
            frame: prepared.metadata.frame,
            ground_effect_profile: prepared.metadata.profile,
            grounding: prepared.metadata.grounding,
          },
        }
      : vehicleSegmentationV3
        ? {
            _diagnostics: vehicleSegmentationV3Diagnostics,
            _metadata: {
              ...standardInference,
              ...vehicleSegmentationV3Diagnostics,
              framing: vehicleSegmentationV3.metadata.framing,
            },
          }
        : vehicleAware
          ? {
              _quality_class: vehicleAware.quality.rating,
              _quality_score: vehicleAware.quality.score,
              _metadata: {
                pipeline_version: VEHICLE_AWARE_PIPELINE_VERSION,
                method: vehicleAware.method,
                detector: vehicleAware.detector,
                roi: vehicleAware.roi,
                quality: vehicleAware.quality,
                framing: vehicleAware.framing,
              },
            }
          : {
              _quality_class: standardQuality,
              _diagnostics: standardDiagnostics,
            }),
  };
  const { data: committed, error: commitError } = await client.rpc(
    commitRpc as never,
    commitArguments as never,
  );
  if (commitError || !committed) {
    // Storage and Postgres are separate transactions. Remove only the exact
    // just-produced object when finalization/cancellation rejects promotion.
    await client.storage
      .from(PRIVATE_BUCKET)
      .remove(prepared ? [path, prepared.path] : [path])
      .catch(() => undefined);
    throw new Error("background_variant_finalize_failed");
  }
  return {
    media_asset_id: source.media_asset_id,
    photo_id: source.photo_id,
    variant_id: prepared
      ? asObject<{ prepared_variant_id: string }>(committed as Json).prepared_variant_id
      : committed,
    cutout_variant_id: prepared
      ? asObject<{ cutout_variant_id: string }>(committed as Json).cutout_variant_id
      : committed,
    width: metadata.width,
    height: metadata.height,
    bytes: bytes.length,
    strategy: prepared
      ? "standard_with_default_backdrop"
      : vehicleSegmentationV3
        ? "vehicle_segmentation_v3_review"
        : vehicleAware
          ? vehicleAware.method
          : "standard",
    quality: vehicleSegmentationV3
      ? "needs_review"
      : (vehicleAware?.quality.rating ?? standardQuality),
    quality_score: vehicleSegmentationV3?.quality.score ?? vehicleAware?.quality.score ?? null,
    mask_diagnostics: vehicleSegmentationV3Diagnostics ?? standardDiagnostics,
    inference: standardInference,
  };
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

async function cleanupDeletedVehicleStorage(client: SupabaseClient<Database>, job: BackgroundJob) {
  const operationId = payloadId(job, "operation_id");
  const { data, error } = await client.rpc(
    "worker_get_vehicle_deletion_operation" as never,
    { _operation_id: operationId } as never,
  );
  if (error) throw new Error("vehicle_deletion_lookup_failed");
  const operation = asObject<VehicleDeletionOperation>(data as Json | null);
  if (operation.storage_status === "succeeded") {
    return { already_clean: true, operation_id: operationId };
  }

  try {
    const grouped = new Map<string, Set<string>>();
    for (const object of operation.storage_manifest) {
      if (
        !object ||
        typeof object.bucket !== "string" ||
        typeof object.path !== "string" ||
        !VEHICLE_DELETE_BUCKETS.has(object.bucket) ||
        !object.path ||
        object.path.startsWith("/") ||
        object.path.split("/").includes("..")
      ) {
        throw new Error("invalid_vehicle_deletion_manifest");
      }
      const paths = grouped.get(object.bucket) ?? new Set<string>();
      paths.add(object.path);
      grouped.set(object.bucket, paths);
    }

    let deletedObjectCount = 0;
    for (const [bucket, uniquePaths] of grouped) {
      const paths = [...uniquePaths];
      for (let index = 0; index < paths.length; index += 100) {
        const batch = paths.slice(index, index + 100);
        const { error: removeError } = await client.storage.from(bucket).remove(batch);
        if (removeError) throw new Error("vehicle_storage_delete_failed");
        deletedObjectCount += batch.length;
      }
    }

    const { data: completed, error: completeError } = await client.rpc(
      "worker_complete_vehicle_deletion_storage_cleanup" as never,
      { _operation_id: operationId, _deleted_object_count: deletedObjectCount } as never,
    );
    if (completeError || completed !== true) throw new Error("vehicle_deletion_finalize_failed");
    return { operation_id: operationId, deleted_objects: deletedObjectCount };
  } catch (cause) {
    const errorCode = cause instanceof Error ? cause.message : "vehicle_storage_cleanup_failed";
    await client.rpc(
      "worker_fail_vehicle_deletion_storage_cleanup" as never,
      {
        _operation_id: operationId,
        _safe_error_code: errorCode,
      } as never,
    );
    throw cause;
  }
}

export function createMediaJobHandlers(
  client: SupabaseClient<Database>,
): Record<string, JobHandler> {
  return {
    "media.legacy.migrate": (job) => migrateLegacyMedia(client, job),
    "media.thumbnail.generate": (job) => generateThumbnails(client, job),
    "media.background.remove": (job) => removeMediaBackground(client, job),
    "media.legacy.lockdown": () => lockdownLegacyBucket(client),
    "vehicle.storage.cleanup": (job) => cleanupDeletedVehicleStorage(client, job),
  };
}
