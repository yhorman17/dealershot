import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeVehicleAlpha,
  buildGroundEffectProfile,
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
  assert.equal(profile.reflection.opacity, 5);
  assert.equal(profile.shadow.opacity, 22);
  assert.ok(profile.reflection.heightFactor <= 0.13);
  assert.ok(profile.reflection.widthFactor <= 0.76);
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
  assert.match(editor, /trackGroundEffect\(setShadowOpacity\)/);
  assert.match(editor, /trackGroundEffect\(setReflectionOpacity\)/);
  assert.doesNotMatch(editor, /buildOvalShadowCanvas/);
});
