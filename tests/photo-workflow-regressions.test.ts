import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("Customize owns a recoverable portal lifecycle", () => {
  const vehiclePhotos = read("src/components/VehiclePhotos.tsx");
  const editor = read("src/components/BackgroundEditor.tsx");
  const boundary = read("src/components/PhotoEditorBoundary.tsx");

  assert.match(vehiclePhotos, /lazy\(\(\) =>[\s\S]*import\("@\/components\/BackgroundEditor"\)/);
  assert.match(vehiclePhotos, /<PhotoEditorBoundary[\s\S]*<Suspense fallback=\{<EditorLoading/);
  assert.match(
    editor,
    /<DialogPrimitive\.Portal>/,
    "editor content must escape page stacking contexts",
  );
  assert.match(editor, /<DialogPrimitive\.Close asChild>/, "editor has a visible close control");
  assert.match(boundary, /getDerivedStateFromError/);
  assert.match(boundary, /Customize could not open/);
  assert.match(
    boundary,
    /<Dialog open onOpenChange=/,
    "loading and failure states are escapable dialogs",
  );
});

test("background removal is explicit and absent from the capture critical path", () => {
  const vehiclePhotos = read("src/components/VehiclePhotos.tsx");
  const editor = read("src/components/BackgroundEditor.tsx");

  assert.doesNotMatch(vehiclePhotos, /cutout-queue|@imgly\/background-removal|removeBackground/);
  assert.match(editor, /const createCutout = async/);
  assert.match(editor, /await import\("@imgly\/background-removal"\)/);
  assert.match(editor, /onClick=\{\(\) => void createCutout\(\)\}/);
});

test("guided capture persists raw originals through a bounded retryable queue", () => {
  const source = read("src/components/VehiclePhotos.tsx");

  assert.match(source, /createUploadQueue<CaptureUpload>/);
  assert.match(source, /\/originals\//);
  assert.match(source, /original_image_url: imageUrl/);
  assert.match(source, /photo_state: "raw"/);
  assert.match(source, /is_cutout: false/);
  assert.match(source, /cutout_status: "none"/);
  assert.match(source, /uploadQueue\.retryFailed\(\)/);
  assert.match(source, /await uploadQueue\.waitForIdle\(\)/);
  assert.match(source, /complete_photo_capture_session/);
});

test("phone capture hides office preparation controls below the md breakpoint", () => {
  const source = read("src/components/VehiclePhotos.tsx");

  assert.match(source, /hidden[^"]*md:block[\s\S]*Customize/);
  assert.match(source, /hidden[^"]*md:flex/);
  assert.match(source, /Complete Photos/);
  assert.match(source, /capture="environment"/);
});

test("Bulk Photos supports raw intake, completion, organization, and no-reupload association", () => {
  const list = read("src/routes/_authenticated/bulk-photos.tsx");
  const workspace = read("src/routes/_authenticated/bulk-photos.$id.tsx");

  assert.match(list, /mode: "bulk"/);
  assert.match(list, /vin: normalizedVin/);
  assert.match(list, /import\("@\/components\/VinScannerModal"\)/);
  assert.match(list, /aria-label="Scan VIN"/);
  assert.match(workspace, /createUploadQueue<BulkUpload>/);
  assert.match(workspace, /Complete Bulk Photos/);
  assert.match(workspace, /Guided shot assignment/);
  assert.match(workspace, /Mark Main Image/);
  assert.match(workspace, /Customize Selected/);
  assert.match(workspace, /customize: customizePhotoId/);
  assert.match(workspace, /associate_bulk_photo_session/);
  assert.match(workspace, /without re-uploading photos/);
  assert.match(workspace, /DecodeVinValues/);
});

test("capture-session migration preserves originals and enforces tenant-scoped state changes", () => {
  const migration = read("supabase/migrations/20260812181633_photo_capture_sessions.sql");

  assert.match(migration, /CREATE TABLE public\.photo_capture_sessions/);
  assert.match(migration, /CHECK \(mode IN \('guided', 'bulk'\)\)/);
  assert.match(migration, /CHECK \(status IN \('in_progress', 'completed', 'prepared'\)\)/);
  assert.match(migration, /NEW\.original_image_url := OLD\.original_image_url/);
  assert.match(migration, /private\.validate_photo_capture_session/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /current_user_has_active_membership\(dealership_id\)/);
  assert.match(migration, /REVOKE ALL ON public\.photo_capture_sessions/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.complete_photo_capture_session/);
});
