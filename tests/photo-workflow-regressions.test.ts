import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  const backgroundRemoval = read("src/lib/background-removal.ts");
  assert.match(backgroundRemoval, /await import\("@imgly\/background-removal"\)/);
  assert.match(editor, /removeInFlightRef\.current/);
  assert.match(editor, /removeVehicleBackground\(/);
  assert.match(editor, /Your original photo was not changed\. Try again\./);
  assert.match(editor, /onClick=\{\(\) => void createCutout\(\)\}/);
  assert.equal(existsSync(path.join(root, "src/lib/cutout-queue.ts")), false);
});

test("Customize uses one persistent preview canvas across every controls tab", () => {
  const editor = read("src/components/BackgroundEditor.tsx");
  assert.match(editor, /data-testid="customize-preview-canvas"/);
  assert.match(editor, /tab changes only swap controls/);
  assert.match(editor, /ctx\.drawImage\(originalImg/);
  assert.match(editor, /if \(cutoutImg && bounds\)/);
  assert.doesNotMatch(editor, /adjustPreviewRef/);
  assert.doesNotMatch(editor, /key=\{activeTab\}[\s\S]{0,300}<canvas/);
  for (const tab of ["background", "adjust", "shadow", "reflection", "overlay"]) {
    assert.match(editor, new RegExp(`activeTab === "${tab}"`));
  }
});

test("private cutout references are resolved and editor capability gates UI access", () => {
  const vehiclePhotos = read("src/components/VehiclePhotos.tsx");
  const privateMedia = read("src/lib/private-media.ts");
  const mediaApi = read("src/lib/api/media.functions.ts");
  assert.match(vehiclePhotos, /resolveAuthorizedMediaReference/);
  assert.match(vehiclePhotos, /capabilities\?\.media === true/);
  assert.match(vehiclePhotos, /it\.photo && canCustomize/);
  assert.match(privateMedia, /PRIVATE_MEDIA_REFERENCE/);
  assert.match(privateMedia, /getAuthorizedMediaVariantUrl/);
  assert.match(mediaApi, /get_media_delivery_manifest/);
  assert.match(mediaApi, /_variant_id: data\.variant_id/);
  assert.match(mediaApi, /requireSupabaseAuth/);
});

test("mobile operational controls prevent accidental tap zoom without disabling pinch zoom", () => {
  const styles = read("src/styles.css");
  const rootRoute = read("src/routes/__root.tsx");

  assert.match(
    styles,
    /:where\(button, \[role="button"\], a\[href\]\) \{[\s\S]*touch-action: manipulation/,
  );
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*font-size: 1rem/);
  assert.match(rootRoute, /width=device-width, initial-scale=1, viewport-fit=cover/);
  assert.doesNotMatch(rootRoute, /user-scalable=no|maximum-scale=1/);
});

test("guided capture persists raw originals through a bounded retryable queue", () => {
  const source = read("src/components/VehiclePhotos.tsx");

  assert.match(source, /createUploadQueue<CaptureUpload>/);
  assert.match(source, /await uploadPrivateOriginal\(/);
  assert.doesNotMatch(source, /getPublicUrl|from\("photos"\)[\s\S]{0,160}\.insert\(/);
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

test("Bulk Capture supports vehicle-first intake, durable review, and background selection", () => {
  const list = read("src/routes/_authenticated/bulk-photos.tsx");
  const workspace = read("src/routes/_authenticated/bulk-photos.$id.tsx");
  const addVehicle = read("src/routes/_authenticated/vehicles.new.tsx");

  assert.match(list, /Add vehicle & start photos/);
  assert.match(addVehicle, /_mode: method/);
  assert.match(addVehicle, /rpc\("start_photo_capture_session"/);
  assert.match(addVehicle, /to: "\/bulk-photos\/\$id"/);
  assert.match(workspace, /createUploadQueue<BulkUpload>/);
  assert.match(workspace, /Finish photos/);
  assert.match(workspace, /Review photos/);
  assert.match(workspace, /Retake \/ replace/);
  assert.match(workspace, /Select photos to process/);
  assert.match(workspace, /associate_bulk_photo_session/);
  assert.match(workspace, /queue_bulk_background_removal/);
  assert.match(workspace, /Yes, next vehicle/);
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

test("hosted capture starts through an idempotent authorization-checked RPC", () => {
  const source = read("src/components/VehiclePhotos.tsx");
  const migration = read("supabase/migrations/20260817193000_hosted_capture_and_access_fixes.sql");

  assert.match(source, /rpc\("start_photo_capture_session"/);
  assert.doesNotMatch(source, /from\("photo_capture_sessions"\)[\s\S]{0,160}\.insert\(/);
  assert.match(migration, /FUNCTION public\.start_photo_capture_session/);
  assert.match(migration, /private\.current_user_has_active_membership\(_dealership_id\)/);
  assert.match(migration, /vehicle_store_id IS DISTINCT FROM _dealership_id/);
  assert.match(migration, /ON CONFLICT DO NOTHING/);
  assert.match(migration, /created_by = actor_id/);
  assert.match(migration, /SET search_path = ''/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.start_photo_capture_session/);
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
