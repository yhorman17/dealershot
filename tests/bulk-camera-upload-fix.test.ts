import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("landscape camera makes the preview the full stage without restarting media", () => {
  const camera = read("src/components/BulkCamera.tsx");
  const styles = read("src/styles.css");
  assert.match(styles, /@media \(orientation: landscape\) and \(max-height: 600px\)/);
  assert.match(styles, /\.bulk-camera-stage\s*\{[\s\S]*position: absolute;[\s\S]*inset: 0;/);
  assert.match(styles, /\.bulk-camera-controls\s*\{[\s\S]*position: absolute;/);
  assert.match(camera, /className="h-full w-full object-contain"/);
  assert.doesNotMatch(camera, /orientationchange|screen\.orientation/);
});

test("camera exposes only hardware-backed zoom and captures high quality JPEG", () => {
  const camera = read("src/components/BulkCamera.tsx");
  assert.match(camera, /getCameraZoomState\(videoTrack\)/);
  assert.match(camera, /applyCameraZoom\(track, value, zoomRange\)/);
  assert.match(camera, /type="range"/);
  assert.match(camera, /"image\/jpeg",\s*0\.94/);
  assert.doesNotMatch(camera, /transform:\s*scale|scale\(/);
});

test("Bulk UI keeps per-file failure and retry state without exposing database errors", () => {
  const camera = read("src/components/BulkCamera.tsx");
  const workspace = read("src/routes/_authenticated/bulk-photos.$id.tsx");
  assert.match(camera, /upload\.state === "failed"/);
  assert.match(camera, /onRetryUpload\(upload\.id\)/);
  assert.match(workspace, /uploadQueue\.retry\(entryId\)/);
  assert.match(workspace, /Upload failed\. Check your connection and try again\./);
  assert.doesNotMatch(workspace, /entry\.error/);
});

test("trusted Bulk finalization preserves browser and cross-store authorization", () => {
  const migration = read(
    "supabase/migrations/20260818201928_fix_bulk_private_upload_finalization.sql",
  );
  const mediaServer = read("src/lib/api/media.functions.ts");
  assert.match(migration, /current_setting\('request\.jwt\.claim\.role', true\)/);
  assert.match(migration, /request_role = 'service_role'/);
  assert.match(migration, /NEW\.media_asset_id IS NOT NULL/);
  assert.match(migration, /private\.actor_can_upload_media\(/);
  assert.match(migration, /private\.current_user_can_mutate_capture_session\(target\.id\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION private\.serialize_bulk_photo_item_insert/);
  assert.match(mediaServer, /finalize_private_bulk_upload/);
  assert.match(mediaServer, /_actor_id: context\.userId/);
  assert.match(mediaServer, /await supabaseAdmin\.storage[\s\S]*remove\(\[data\.path\]\)/);
});
