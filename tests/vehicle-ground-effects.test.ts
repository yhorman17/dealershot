import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeVehicleAlpha,
  buildVehicleCompositionFrame,
  buildGroundEffectProfile,
  PREPARED_IMAGE_HEIGHT,
  PREPARED_IMAGE_WIDTH,
} from "../src/lib/vehicle-ground-effects.ts";

function alphaMask(width: number, height: number, contains: (x: number, y: number) => boolean) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (contains(x, y)) rgba[(y * width + x) * 4 + 3] = 255;
    }
  }
  return rgba;
}

test("explicit dealership shot labels select the correct ground-effect family", () => {
  const rgba = alphaMask(200, 120, (x, y) => x >= 25 && x <= 174 && y >= 30 && y <= 94);

  assert.equal(analyzeVehicleAlpha(rgba, 200, 120, "Driver side").view, "side");
  assert.equal(analyzeVehicleAlpha(rgba, 200, 120, "Front").view, "front");
  assert.equal(analyzeVehicleAlpha(rgba, 200, 120, "Rear").view, "rear");
  assert.equal(analyzeVehicleAlpha(rgba, 200, 120, "Front 3/4").view, "front-three-quarter");
  assert.equal(
    analyzeVehicleAlpha(rgba, 200, 120, "Rear three-quarter").view,
    "rear-three-quarter",
  );
  assert.equal(analyzeVehicleAlpha(rgba, 200, 120, "front_3q_driver").view, "front-three-quarter");
});

test("front and rear defaults are compact while side-profile effects remain readable", () => {
  const sideMask = alphaMask(220, 120, (x, y) => x >= 20 && x <= 200 && y >= 38 && y <= 92);
  const endMask = alphaMask(160, 140, (x, y) => x >= 44 && x <= 116 && y >= 28 && y <= 116);
  const side = buildGroundEffectProfile(analyzeVehicleAlpha(sideMask, 220, 120, "Passenger side"));
  const front = buildGroundEffectProfile(analyzeVehicleAlpha(endMask, 160, 140, "Front"));
  const rear = buildGroundEffectProfile(analyzeVehicleAlpha(endMask, 160, 140, "Rear"));

  assert.ok(side.reflection.heightFactor > front.reflection.heightFactor);
  assert.ok(side.reflection.opacity > front.reflection.opacity);
  assert.ok(side.shadow.widthFactor > front.shadow.widthFactor);
  assert.equal(front.reflection.heightFactor, rear.reflection.heightFactor);
  assert.equal(front.shadow.widthFactor, rear.shadow.widthFactor);
});

test("three-quarter defaults follow the lower contact offset without aggressive skew", () => {
  const shiftedFootprint = alphaMask(220, 140, (x, y) => {
    if (y < 30 || y > 118) return false;
    if (y > 90) return x >= 72 && x <= 202;
    return x >= 28 && x <= 184;
  });
  const analysis = analyzeVehicleAlpha(shiftedFootprint, 220, 140, "Front 3/4");
  const profile = buildGroundEffectProfile(analysis);

  assert.equal(analysis.view, "front-three-quarter");
  assert.ok(analysis.lowerCenterOffset > 0);
  assert.ok(profile.shadow.skew > 0 && profile.shadow.skew <= 0.11);
  assert.ok(profile.reflection.skew > 0 && profile.reflection.skew <= 0.14);
  assert.ok(profile.reflection.widthFactor <= 1);
});

test("uncertain silhouettes choose reduced effects instead of an obvious generic mirror", () => {
  const sparse = alphaMask(200, 120, (x, y) => x >= 99 && x <= 101 && y >= 59 && y <= 61);
  const analysis = analyzeVehicleAlpha(sparse, 200, 120);
  const profile = buildGroundEffectProfile(analysis);

  assert.ok(analysis.alphaCoverage < 0.015);
  assert.equal(profile.reflection.opacity, 3);
  assert.equal(profile.shadow.opacity, 18);
  assert.ok(profile.reflection.heightFactor <= 0.2);
  assert.ok(profile.reflection.widthFactor <= 0.76);
});

test("visible alpha bounds auto-center on the 1600 by 1200 dealership composition", () => {
  const rgba = alphaMask(2400, 1600, (x, y) => x >= 430 && x <= 2050 && y >= 460 && y <= 1320);
  const analysis = analyzeVehicleAlpha(rgba, 2400, 1600, "Front 3/4");
  const frame = buildVehicleCompositionFrame(2400, 1600, analysis);
  const center = (frame.visibleBounds.left + frame.visibleBounds.right) / 2;

  assert.equal(PREPARED_IMAGE_WIDTH, 1600);
  assert.equal(PREPARED_IMAGE_HEIGHT, 1200);
  assert.ok(Math.abs(center - PREPARED_IMAGE_WIDTH / 2) < 1);
  assert.ok(Math.abs(frame.visibleBounds.bottom - PREPARED_IMAGE_HEIGHT * 0.74) < 1);
  assert.ok(frame.visibleBounds.top > PREPARED_IMAGE_HEIGHT * 0.08);
  assert.ok(frame.visibleBounds.left > PREPARED_IMAGE_WIDTH * 0.08);
  assert.ok(frame.visibleBounds.right < PREPARED_IMAGE_WIDTH * 0.92);
});

test("manual composition adjustments apply after automatic framing", () => {
  const rgba = alphaMask(800, 600, (x, y) => x >= 100 && x <= 700 && y >= 180 && y <= 500);
  const analysis = analyzeVehicleAlpha(rgba, 800, 600, "Driver side");
  const automatic = buildVehicleCompositionFrame(800, 600, analysis);
  const adjusted = buildVehicleCompositionFrame(800, 600, analysis, 1600, 1200, {
    offsetXPct: 5,
    offsetYPct: -3,
    scalePct: 90,
  });

  assert.ok(adjusted.visibleBounds.left > automatic.visibleBounds.left);
  assert.ok(adjusted.visibleBounds.bottom < automatic.visibleBounds.bottom);
  assert.ok(adjusted.width < automatic.width);
});

test("alpha analysis anchors effects to the actual lower contact region", () => {
  const wheels = alphaMask(200, 120, (x, y) => {
    const body = x >= 28 && x <= 172 && y >= 35 && y <= 88;
    const leftWheel = x >= 42 && x <= 65 && y >= 82 && y <= 106;
    const rightWheel = x >= 139 && x <= 162 && y >= 82 && y <= 106;
    return body || leftWheel || rightWheel;
  });
  const analysis = analyzeVehicleAlpha(wheels, 200, 120, "Driver side");

  assert.ok(analysis.contactBounds.left >= analysis.bounds.left);
  assert.ok(analysis.contactBounds.right <= analysis.bounds.right);
  assert.ok(Math.abs(analysis.contactBounds.center - 102) < 5);
});

test("rendering remains silhouette-based and manual controls remain wired", async () => {
  const { readFile } = await import("node:fs/promises");
  const editor = await readFile(
    new URL("../src/components/BackgroundEditor.tsx", import.meta.url),
    "utf8",
  );

  assert.match(editor, /buildContactShadowCanvas/);
  assert.match(editor, /buildReflectionCanvas/);
  assert.match(editor, /profile\.reflection\.heightFactor/);
  assert.match(editor, /analysis\.contactBounds/);
  assert.match(editor, /createRadialGradient/);
  assert.match(editor, /buildVehicleCompositionFrame/);
  assert.match(editor, /PREPARED_IMAGE_WIDTH/);
  assert.match(editor, /PREPARED_IMAGE_HEIGHT/);
  assert.match(editor, /trackGroundEffect\(setShadowOpacity\)/);
  assert.match(editor, /trackGroundEffect\(setReflectionOpacity\)/);
  assert.doesNotMatch(editor, /buildOvalShadowCanvas/);
});
