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

test("photo selection remains registered while capture context and uploads resolve", () => {
  const source = read("src/components/VehiclePhotos.tsx");

  assert.match(source, /captureContextPromiseRef/);
  assert.match(source, /const context = await getCaptureContext\(\)/);
  assert.doesNotMatch(source, /\[dealershipId, user, vehicleId, vehicleVin\]/);
  assert.match(
    source,
    /const registeredPhotoCount = photos\.length \+ pendingUploads \+ failedUploads/,
  );
  assert.match(source, /photos registered/);
  assert.match(source, /safely queued or uploading while you continue/);
  assert.match(source, /Photo upload failed/);
  assert.match(source, /entry\.error \|\| "The original is still available\. Tap Retry Uploads\."/);
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

test("Fix Cutout waits for decoded assets and a measurable viewport", () => {
  const editor = read("src/components/MaskEditor.tsx");

  assert.match(editor, /type EditorPhase = "loading" \| "ready" \| "error" \| "applying"/);
  assert.match(editor, /await fetch\(source/);
  assert.match(editor, /mode: "cors"/);
  assert.match(editor, /await createImageBitmap\(blob\)/);
  assert.match(editor, /took too long to decode/);
  assert.match(editor, /const setViewportNode = useCallback/);
  assert.match(editor, /ref=\{setViewportNode\}/);
  assert.match(editor, /\[open, viewportElement\]/);
  assert.match(editor, /new ResizeObserver\(measure\)/);
  assert.match(editor, /if \(next\.width <= 0 \|\| next\.height <= 0\) return/);
  assert.match(editor, /Loading photo and cutout…/);
  assert.match(editor, /disabled=\{controlsDisabled/);
  assert.match(editor, /disabled=\{phase !== "ready"\}/);
});

test("Fix Cutout renders source RGB and editable alpha in a DPR canvas", () => {
  const editor = read("src/components/MaskEditor.tsx");

  assert.match(editor, /Math\.round\(width \* dpr\)/);
  assert.match(editor, /context\.setTransform\(dpr, 0, 0, dpr, 0, 0\)/);
  assert.match(editor, /context\.drawImage\(source, layout\.left/);
  assert.match(editor, /context\.globalCompositeOperation = "destination-in"/);
  assert.match(editor, /context\.drawImage\(mask, layout\.left/);
  assert.match(editor, /data-testid="mask-editor-canvas"/);
  assert.match(editor, /\[background-image:linear-gradient\(45deg/);
});

test("Fix Cutout has recoverable loading, apply, resize, and tab-return behavior", () => {
  const editor = read("src/components/MaskEditor.tsx");
  const backgroundEditor = read("src/components/BackgroundEditor.tsx");

  assert.match(editor, /Fix Cutout couldn't start\./);
  assert.match(editor, /setRetryNonce\(\(value\) => value \+ 1\)/);
  assert.match(editor, /document\.addEventListener\("visibilitychange", redraw\)/);
  assert.match(editor, /await onApply\(blob\)/);
  assert.match(editor, /if \(!nextOpen && phase === "applying"\) return/);
  assert.match(editor, /setApplyError\(/);
  assert.match(editor, /Your edited mask is still open; try Apply Mask again\./);
  assert.match(backgroundEditor, /onApply=\{applyCorrectedMask\}/);
  assert.match(
    backgroundEditor,
    /catch \(reason\) \{[\s\S]*URL\.revokeObjectURL\(url\);[\s\S]*throw reason/,
  );
});

test("mask editor visual fixture covers retained, missing, and transparent regions", () => {
  const fixture = read("tests/fixtures/mask-editor-harness.tsx");

  assert.match(fixture, /CASE A: a green retained background object/);
  assert.match(fixture, /CASE B: the mask incorrectly removes part of the vehicle roof/);
  assert.match(fixture, /CASE C is the transparent border/);
  assert.match(fixture, /<MaskEditor/);
});
