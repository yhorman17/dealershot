import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { createMediaJobHandlers, ensurePrivateMediaBucket } from "../worker/media.ts";
import type { BackgroundJob } from "../worker/runtime.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(
  path.join(
    root,
    "supabase/migrations/20260817212030_production_media_ledger_private_pipeline.sql",
  ),
  "utf8",
);
const legacyPathBackfill = readFileSync(
  path.join(root, "supabase/migrations/20260817225800_backfill_legacy_media_variant_paths.sql"),
  "utf8",
);
const legacySvgCompatibility = readFileSync(
  path.join(root, "supabase/migrations/20260817231500_preserve_legacy_svg_originals.sql"),
  "utf8",
);
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");

const mediaAssetId = "10000000-0000-0000-0000-000000000001";
const migrationId = "20000000-0000-0000-0000-000000000001";

function mediaJob(jobType: string, payload: Record<string, string>): BackgroundJob {
  return {
    job_id: "30000000-0000-0000-0000-000000000001",
    job_type: jobType,
    payload,
    dealership_id: "40000000-0000-0000-0000-000000000001",
    attempt: 1,
    max_attempts: 6,
    trace_id: "50000000-0000-0000-0000-000000000001",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function fakeMediaClient(
  source: Buffer,
  options: {
    sourcePath?: string;
    destinationBucket?: string;
    contentType?: string;
  } = {},
) {
  const sourcePath = options.sourcePath ?? "legacy/source.jpg";
  const destinationBucket = options.destinationBucket ?? "dealer-media-private";
  const contentType = options.contentType ?? "image/jpeg";
  const filename = sourcePath.replace(/^.*\//, "");
  const destinationPath = `stores/store-a/vehicles/vehicle-a/media/${mediaAssetId}/original/${filename}`;
  const objects = new Map<string, Buffer>([[`vehicle-photos/${sourcePath}`, source]]);
  const buckets = new Map<string, { public: boolean }>([["vehicle-photos", { public: true }]]);
  const registered: Array<Record<string, unknown>> = [];
  let migrationCompleted = false;
  let migrationFailed: string | null = null;

  const client = {
    storage: {
      async listBuckets() {
        return {
          data: [...buckets].map(([id, config]) => ({ id, name: id, ...config })),
          error: null,
        };
      },
      async createBucket(id: string, config: { public: boolean }) {
        buckets.set(id, { public: config.public });
        return { error: null };
      },
      async updateBucket(id: string, config: { public: boolean }) {
        buckets.set(id, { public: config.public });
        return { error: null };
      },
      from(bucket: string) {
        return {
          async download(objectPath: string) {
            const bytes = objects.get(`${bucket}/${objectPath}`);
            return bytes
              ? { data: new Blob([Uint8Array.from(bytes)]), error: null }
              : { data: null, error: { message: "missing" } };
          },
          async upload(objectPath: string, bytes: Buffer, _options: Record<string, unknown>) {
            const key = `${bucket}/${objectPath}`;
            if (objects.has(key)) return { error: { message: "already exists" } };
            objects.set(key, Buffer.from(bytes));
            return { error: null };
          },
        };
      },
    },
    async rpc(name: string, args?: Record<string, unknown>) {
      if (name === "worker_get_media_migration") {
        return {
          data: {
            migration_id: migrationId,
            media_asset_id: mediaAssetId,
            media_variant_id: "60000000-0000-0000-0000-000000000001",
            source_bucket: "vehicle-photos",
            source_path: sourcePath,
            destination_bucket: destinationBucket,
            destination_path: destinationPath,
            state: "legacy",
            variant_type: "original",
            dealership_id: "store-a",
            vehicle_id: "vehicle-a",
          },
          error: null,
        };
      }
      if (
        name === "worker_complete_media_migration" ||
        name === "worker_complete_legacy_svg_migration"
      ) {
        migrationCompleted = true;
        return { data: true, error: null };
      }
      if (name === "worker_fail_media_migration") {
        migrationFailed = String(args?._safe_error_code ?? "unknown");
        return { data: true, error: null };
      }
      if (name === "worker_get_media_asset_source") {
        return {
          data: {
            media_asset_id: mediaAssetId,
            dealership_id: "store-a",
            vehicle_id: "vehicle-a",
            bucket: migrationCompleted ? destinationBucket : "vehicle-photos",
            path: migrationCompleted ? destinationPath : sourcePath,
            photo_id: "70000000-0000-0000-0000-000000000001",
            source_variant_id: "60000000-0000-0000-0000-000000000001",
            content_type: contentType,
          },
          error: null,
        };
      }
      if (name === "worker_register_media_derivative") {
        registered.push(args ?? {});
        return { data: crypto.randomUUID(), error: null };
      }
      if (name === "worker_get_media_migration_status") {
        return {
          data: { total: 1, private: migrationCompleted ? 1 : 0, failed: 0, pending: 0 },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };

  return {
    client,
    objects,
    buckets,
    registered,
    state: () => ({ migrationCompleted, migrationFailed }),
  };
}

test("media ledger migration enforces private identity, lineage, and trusted finalization", () => {
  assert.match(migration, /CREATE TABLE public\.media_assets/);
  assert.match(
    migration,
    /checksum_sha256 text NOT NULL CHECK \(checksum_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/,
  );
  assert.match(migration, /CREATE UNIQUE INDEX media_variants_asset_original_once_idx/);
  assert.match(migration, /source_variant_id/);
  assert.match(
    migration,
    /REVOKE INSERT, DELETE ON public\.photos, public\.bulk_photo_items FROM authenticated/,
  );
  assert.match(migration, /DROP POLICY IF EXISTS "Public read vehicle photos"/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.get_media_delivery_manifest/);
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.finalize_private_photo_upload\([\s\S]{0,220}\) TO service_role/,
  );
});

test("worker creates and maintains a private constrained media bucket", async () => {
  const source = await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#3465a4" },
  })
    .jpeg()
    .toBuffer();
  const fixture = fakeMediaClient(source);
  await ensurePrivateMediaBucket(fixture.client as never);
  assert.deepEqual(fixture.buckets.get("dealer-media-private"), { public: false });
  assert.deepEqual(fixture.buckets.get("dealer-media-legacy-private"), { public: false });
});

test("deployment image carries Sharp's Alpine native runtime packages", () => {
  assert.match(
    dockerfile,
    /COPY --from=build --chown=node:node \/app\/node_modules\/@img \.\/node_modules\/@img/,
  );
});

test("URL-only legacy variants are normalized before private migration jobs enqueue", () => {
  assert.match(legacyPathBackfill, /mv\.image_url LIKE '%\/vehicle-photos\/%'/);
  assert.match(legacyPathBackfill, /INSERT INTO private\.media_storage_migrations/);
  assert.match(legacyPathBackfill, /ON CONFLICT \(source_bucket, source_path\) DO NOTHING/);
  assert.match(legacyPathBackfill, /SET resolution = 'linked'/);
  assert.match(legacyPathBackfill, /'media\.legacy\.lockdown'/);
});

test("legacy SVG finalization is isolated, server-only, and resumable", () => {
  assert.match(legacySvgCompatibility, /dealer-media-legacy-private/);
  assert.match(legacySvgCompatibility, /_content_type <> 'image\/svg\+xml'/);
  assert.match(legacySvgCompatibility, /SET search_path = ''/);
  assert.match(
    legacySvgCompatibility,
    /REVOKE ALL ON FUNCTION public\.worker_complete_legacy_svg_migration/,
  );
  assert.match(legacySvgCompatibility, /\) FROM PUBLIC, anon, authenticated/);
  assert.match(legacySvgCompatibility, /TO service_role/);
});

test("legacy migration verifies exact bytes before finalizing and preserves source", async () => {
  const source = await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#3465a4" },
  })
    .jpeg()
    .toBuffer();
  const fixture = fakeMediaClient(source);
  const handlers = createMediaJobHandlers(fixture.client as never);
  const result = await handlers["media.legacy.migrate"](
    mediaJob("media.legacy.migrate", { migration_id: migrationId }),
  );
  assert.equal(fixture.state().migrationCompleted, true);
  assert.equal(fixture.state().migrationFailed, null);
  assert.equal(fixture.objects.get("vehicle-photos/legacy/source.jpg"), source);
  const copied = fixture.objects.get(
    `dealer-media-private/stores/store-a/vehicles/vehicle-a/media/${mediaAssetId}/original/source.jpg`,
  );
  assert.ok(copied);
  assert.equal(
    createHash("sha256").update(copied).digest("hex"),
    createHash("sha256").update(source).digest("hex"),
  );
  assert.deepEqual(result && "migrated" in result ? result.migrated : false, true);
});

test("legacy SVG fixtures preserve exact bytes privately and render safe WebP previews", async () => {
  const source = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#3465a4"/></svg>',
  );
  const fixture = fakeMediaClient(source, {
    sourcePath: "legacy/source.svg",
    destinationBucket: "dealer-media-legacy-private",
    contentType: "image/svg+xml",
  });
  await ensurePrivateMediaBucket(fixture.client as never);
  const handlers = createMediaJobHandlers(fixture.client as never);
  await handlers["media.legacy.migrate"](
    mediaJob("media.legacy.migrate", { migration_id: migrationId }),
  );
  const copied = fixture.objects.get(
    `dealer-media-legacy-private/stores/store-a/vehicles/vehicle-a/media/${mediaAssetId}/original/source.svg`,
  );
  assert.deepEqual(copied, source);

  await handlers["media.thumbnail.generate"](
    mediaJob("media.thumbnail.generate", { media_asset_id: mediaAssetId }),
  );
  assert.deepEqual(
    fixture.registered.map((entry) => entry._content_type),
    ["image/webp", "image/webp"],
  );
  assert.deepEqual(fixture.objects.get("vehicle-photos/legacy/source.svg"), source);
});

test("thumbnail rendering creates two private WebP derivatives without mutating original", async () => {
  const source = await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#3465a4" },
  })
    .jpeg()
    .toBuffer();
  const fixture = fakeMediaClient(source);
  const handlers = createMediaJobHandlers(fixture.client as never);
  await handlers["media.legacy.migrate"](
    mediaJob("media.legacy.migrate", { migration_id: migrationId }),
  );
  await handlers["media.thumbnail.generate"](
    mediaJob("media.thumbnail.generate", { media_asset_id: mediaAssetId }),
  );

  assert.equal(fixture.registered.length, 2);
  assert.deepEqual(
    fixture.registered.map((entry) => entry._variant_role),
    ["thumbnail_small", "preview"],
  );
  for (const entry of fixture.registered) {
    assert.equal(entry._storage_bucket, "dealer-media-private");
    assert.equal(entry._content_type, "image/webp");
    assert.equal((entry._metadata as { exif_stripped: boolean }).exif_stripped, true);
  }
  assert.equal(fixture.objects.get("vehicle-photos/legacy/source.jpg"), source);
});

test("legacy bucket lockdown is impossible before every migration verifies", async () => {
  const source = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#3465a4" },
  })
    .jpeg()
    .toBuffer();
  const fixture = fakeMediaClient(source);
  const handlers = createMediaJobHandlers(fixture.client as never);
  await assert.rejects(
    handlers["media.legacy.lockdown"](mediaJob("media.legacy.lockdown", {})),
    /migration_not_complete/,
  );
  assert.equal(fixture.buckets.get("vehicle-photos")?.public, true);
});
