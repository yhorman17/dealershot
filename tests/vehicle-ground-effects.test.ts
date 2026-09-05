import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeVehicleAlpha,
  buildAmbientShadowFootprint,
  buildContactShadowLobes,
  buildVehicleCompositionFrame,
  buildGroundEffectProfile,
  buildGroundPlaneGeometry,
  buildGroundReflectionSlices,
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
  assert.equal(profile.reflection.opacity, 0);
  assert.equal(profile.shadow.opacity, 28);
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
  assert.equal(analysis.contactZones.length, 2);
  assert.ok(Math.abs(analysis.contactZones[0]!.center - 53.5) < 3);
  assert.ok(Math.abs(analysis.contactZones[1]!.center - 150.5) < 3);
  assert.equal(analysis.groundY, 106);
  assert.ok(analysis.lowerContour.length >= 20);
});

test("front, rear, side, and three-quarter fixtures share one plane without flattening far contacts", () => {
  const fixtures = [
    { label: "Front", width: 160, left: 45, right: 115 },
    { label: "Rear", width: 160, left: 43, right: 117 },
    { label: "Driver side", width: 220, left: 20, right: 200 },
    { label: "Front 3/4", width: 210, left: 24, right: 190 },
    { label: "Rear 3/4", width: 210, left: 22, right: 188 },
  ];

  for (const fixture of fixtures) {
    const rgba = alphaMask(fixture.width, 140, (x, y) => {
      const body = x >= fixture.left && x <= fixture.right && y >= 34 && y <= 102;
      const leftWheel = x >= fixture.left + 14 && x <= fixture.left + 30 && y >= 96 && y <= 120;
      const rightWheel = x >= fixture.right - 30 && x <= fixture.right - 14 && y >= 96 && y <= 120;
      return body || leftWheel || rightWheel;
    });
    const analysis = analyzeVehicleAlpha(rgba, fixture.width, 140, fixture.label);
    const geometry = buildGroundPlaneGeometry(fixture.width, 140, analysis);
    assert.ok(Math.abs(geometry.baseline - geometry.frame.groundBaseline) < 0.001);
    assert.ok(geometry.contactZones.length >= 2, fixture.label);
    assert.ok(geometry.contactZones.every((zone) => zone.groundY <= geometry.frame.groundBaseline));
    assert.ok(
      geometry.contactZones.some(
        (zone) => Math.abs(zone.groundY - geometry.frame.groundBaseline) < 0.001,
      ),
      fixture.label,
    );
    assert.ok(geometry.contactLeft >= geometry.vehicleLeft, fixture.label);
    assert.ok(geometry.contactRight <= geometry.vehicleRight, fixture.label);
  }
});

test("ground-plane projection follows manual vehicle adjustments without stale anchors", () => {
  const rgba = alphaMask(240, 150, (x, y) => {
    const body = x >= 32 && x <= 208 && y >= 40 && y <= 108;
    const wheels = ((x >= 52 && x <= 76) || (x >= 164 && x <= 188)) && y >= 100 && y <= 132;
    return body || wheels;
  });
  const analysis = analyzeVehicleAlpha(rgba, 240, 150, "Front 3/4");
  const automatic = buildGroundPlaneGeometry(240, 150, analysis);
  const adjusted = buildGroundPlaneGeometry(240, 150, analysis, 1600, 1200, {
    offsetXPct: 4,
    offsetYPct: -2,
    scalePct: 92,
  });

  assert.ok(adjusted.baseline < automatic.baseline);
  assert.ok(adjusted.contactCenter > automatic.contactCenter);
  assert.ok(adjusted.vehicleWidth < automatic.vehicleWidth);
  assert.ok(adjusted.contactZones.every((zone) => zone.groundY <= adjusted.baseline));
});

test("grounding V2 shares one baseline across localized contacts, ambient footprint, and reflection", () => {
  const views = [
    "Front",
    "Rear",
    "Driver side",
    "Passenger side",
    "Front 3/4 driver",
    "Front 3/4 passenger",
    "Rear 3/4 driver",
    "Rear 3/4 passenger",
  ];

  for (const view of views) {
    const rgba = alphaMask(260, 160, (x, y) => {
      const threeQuarter = view.includes("3/4");
      const direction = view.includes("passenger") ? -1 : 1;
      const shift = threeQuarter ? Math.round(((y - 40) / 80) * direction * 14) : 0;
      const body = y >= 38 && y <= 112 && x >= 35 + shift && x <= 225 + shift;
      const nearWheel = x >= 155 + shift && x <= 185 + shift && y >= 103 && y <= 140;
      const farWheel = x >= 62 + shift && x <= 83 + shift && y >= 100 && y <= 132;
      return body || nearWheel || farWheel;
    });
    const analysis = analyzeVehicleAlpha(rgba, 260, 160, view);
    const profile = buildGroundEffectProfile(analysis);
    const geometry = buildGroundPlaneGeometry(260, 160, analysis);
    const footprint = buildAmbientShadowFootprint(geometry, profile, profile.shadow.scale);
    const contactLobes = buildContactShadowLobes(
      geometry,
      profile,
      profile.shadow.opacity / 100,
      profile.shadow.scale,
    );
    const slices = buildGroundReflectionSlices(
      analysis,
      geometry,
      profile,
      profile.reflection.scale,
    );

    assert.ok(geometry.contactZones.length >= 2, view);
    assert.ok(
      geometry.contactZones.every((zone) => zone.groundY <= geometry.baseline),
      view,
    );
    assert.ok(
      footprint.some((point) => Math.abs(point.y - (geometry.baseline - 1)) < 0.001),
      view,
    );
    assert.ok(
      footprint.some((point) => point.y > geometry.baseline),
      view,
    );
    assert.ok(slices.length > 0, view);
    assert.equal(contactLobes.length, geometry.contactZones.length, view);
    assert.ok(
      contactLobes.every((lobe) => lobe.radiusY >= 4),
      view,
    );
    assert.ok(
      contactLobes.every((lobe) => lobe.coreOpacity > lobe.midOpacity),
      view,
    );
    assert.ok(Math.abs(slices[0]!.destinationY - geometry.baseline) < 0.001, view);
    assert.ok(
      slices.every((slice) => slice.destinationY >= geometry.baseline),
      view,
    );
    assert.ok(slices.at(-1)!.opacity < slices[0]!.opacity, view);
    assert.ok(slices.at(-1)!.blur > slices[0]!.blur, view);
  }
});

test("uncertain grounding keeps contact support but disables reflection", () => {
  const sparse = alphaMask(240, 160, (x, y) => x >= 118 && x <= 121 && y >= 80 && y <= 84);
  const analysis = analyzeVehicleAlpha(sparse, 240, 160);
  const profile = buildGroundEffectProfile(analysis);
  const geometry = buildGroundPlaneGeometry(240, 160, analysis);

  assert.equal(profile.reflection.opacity, 0);
  assert.deepEqual(buildGroundReflectionSlices(analysis, geometry, profile), []);
  assert.ok(buildAmbientShadowFootprint(geometry, profile).length >= 4);
});

test("backdrop floor finish changes reflection honestly without moving the shared plane", () => {
  const rgba = alphaMask(240, 150, (x, y) => {
    const body = x >= 30 && x <= 210 && y >= 36 && y <= 108;
    const wheels = ((x >= 48 && x <= 74) || (x >= 166 && x <= 192)) && y >= 100 && y <= 132;
    return body || wheels;
  });
  const analysis = analyzeVehicleAlpha(rgba, 240, 150, "Front 3/4 driver");
  const matte = buildGroundEffectProfile(analysis, "matte");
  const glossy = buildGroundEffectProfile(analysis, "glossy");
  const geometry = buildGroundPlaneGeometry(240, 150, analysis);
  const matteSlices = buildGroundReflectionSlices(analysis, geometry, matte);
  const glossySlices = buildGroundReflectionSlices(analysis, geometry, glossy);

  assert.equal(matte.floorFinish, "matte");
  assert.equal(glossy.floorFinish, "glossy");
  assert.ok(glossy.reflection.opacity > matte.reflection.opacity * 4);
  assert.ok(glossySlices.at(-1)!.destinationY > matteSlices.at(-1)!.destinationY);
  assert.equal(glossySlices[0]!.destinationY, matteSlices[0]!.destinationY);
  assert.equal(glossySlices[0]!.destinationY, geometry.baseline);
});

test("wide asymmetric dealership silhouettes remain three-quarter and recover two supports", () => {
  const wideThreeQuarter = alphaMask(240, 140, (x, y) => {
    const bodyBottom = Math.round(92 + ((x - 24) / 190) * 8);
    const body = x >= 24 && x <= 214 && y >= 32 && y <= bodyBottom;
    const nearWheel = x >= 126 && x <= 158 && y >= 86 && y <= 126;
    const farWheel = x >= 48 && x <= 70 && y >= 84 && y <= 113;
    return body || nearWheel || farWheel;
  });
  const analysis = analyzeVehicleAlpha(wideThreeQuarter, 240, 140);
  const geometry = buildGroundPlaneGeometry(240, 140, analysis);

  assert.equal(analysis.view, "three-quarter");
  assert.ok(analysis.contactZones.length >= 2);
  assert.ok(new Set(geometry.contactZones.map((zone) => Math.round(zone.groundY))).size >= 2);
  assert.equal(Math.max(...geometry.contactZones.map((zone) => zone.groundY)), geometry.baseline);
});

test("rendering remains silhouette-based and manual controls remain wired", async () => {
  const { readFile } = await import("node:fs/promises");
  const [editor, effects] = await Promise.all([
    readFile(new URL("../src/components/BackgroundEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/vehicle-ground-effects.ts", import.meta.url), "utf8"),
  ]);

  assert.match(editor, /buildContactShadowCanvas/);
  assert.match(editor, /buildReflectionCanvas/);
  assert.match(editor, /buildGroundPlaneGeometry/);
  assert.match(editor, /buildContactShadowLobes/);
  assert.match(editor, /geometry\.contactZones/);
  assert.match(editor, /ctx\.translate\(lobe\.centerX, lobe\.centerY\)/);
  assert.match(editor, /buildGroundReflectionSlices/);
  assert.match(editor, /buildAmbientShadowFootprint/);
  assert.match(effects, /profile\.reflection\.heightFactor/);
  assert.match(effects, /profile\.reflection\.perspectiveTaper/);
  assert.match(effects, /Math\.exp\(-profile\.reflection\.distanceDecay \* distance\)/);
  assert.match(editor, /createRadialGradient/);
  assert.match(editor, /buildVehicleCompositionFrame/);
  assert.match(editor, /PREPARED_IMAGE_WIDTH/);
  assert.match(editor, /PREPARED_IMAGE_HEIGHT/);
  assert.match(editor, /trackGroundEffect\(setShadowOpacity\)/);
  assert.match(editor, /trackGroundEffect\(setReflectionOpacity\)/);
  assert.doesNotMatch(editor, /buildOvalShadowCanvas/);
  assert.doesNotMatch(editor, /drawTintedProjection/);
});
