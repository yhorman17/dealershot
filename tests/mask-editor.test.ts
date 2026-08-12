import test from "node:test";
import assert from "node:assert/strict";
import {
  compositeOriginalWithMask,
  getEditorImageLayout,
  getContainedImageRect,
  isPointInsideImage,
  mapPointerToImage,
  mapViewportPointToImage,
  paintMask,
  paintMaskStrokeInPlace,
} from "../src/lib/mask-editor.ts";

test("erase and restore change only alpha mask state", () => {
  const originalMask = new Uint8ClampedArray(25).fill(255);
  const erased = paintMask(originalMask, 5, 5, { x: 2, y: 2 }, 1, "erase", 1);
  assert.equal(erased[12], 0);
  assert.equal(originalMask[12], 255, "mask edits stay non-destructive");
  const restored = paintMask(erased, 5, 5, { x: 2, y: 2 }, 1, "restore", 1);
  assert.equal(restored[12], 255);
});

test("restore reveals immutable original RGB pixels", () => {
  const original = new Uint8ClampedArray([12, 34, 56, 255, 78, 90, 123, 255]);
  const output = compositeOriginalWithMask(original, new Uint8ClampedArray([0, 200]));
  assert.deepEqual(Array.from(output), [12, 34, 56, 0, 78, 90, 123, 200]);
  assert.deepEqual(Array.from(original), [12, 34, 56, 255, 78, 90, 123, 255]);
});

test("pointer coordinates remain correct with CSS scale, zoom, and pan", () => {
  const mapped = mapPointerToImage(
    { x: 370, y: 245 },
    { left: 100, top: 50, width: 400, height: 300 },
    { width: 1600, height: 1200 },
    { zoom: 2, panX: 20, panY: -5 },
  );
  assert.deepEqual(mapped, { x: 900, y: 700 });
});

test("image-space mapping is independent of retina backing-store density", () => {
  const point = { x: 250, y: 175 };
  const rect = { left: 50, top: 25, width: 400, height: 300 };
  assert.deepEqual(
    mapPointerToImage(point, rect, { width: 2400, height: 1800 }, { zoom: 1, panX: 0, panY: 0 }),
    { x: 1200, y: 900 },
  );
});

test("object-contain letterboxing is excluded from pointer mapping", () => {
  const rect = getContainedImageRect(
    { left: 0, top: 0, width: 1000, height: 1000 },
    { width: 1600, height: 900 },
  );
  assert.deepEqual(rect, { left: 0, top: 218.75, width: 1000, height: 562.5 });
  assert.deepEqual(
    mapPointerToImage(
      { x: 500, y: 500 },
      rect,
      { width: 1600, height: 900 },
      { zoom: 1, panX: 0, panY: 0 },
    ),
    { x: 800, y: 450 },
  );
});

test("a non-zero viewport produces a centered valid initial fit", () => {
  const layout = getEditorImageLayout(
    { width: 960, height: 640 },
    { width: 1600, height: 900 },
    { zoom: 1, panX: 0, panY: 0 },
  );
  assert.ok(layout);
  assert.ok(Math.abs(layout.width - 912) < 0.0001);
  assert.ok(Math.abs(layout.height - 513) < 0.0001);
  assert.ok(Math.abs(layout.left - 24) < 0.0001);
  assert.ok(Math.abs(layout.top - 63.5) < 0.0001);
  assert.equal(
    getEditorImageLayout(
      { width: 0, height: 640 },
      { width: 1600, height: 900 },
      { zoom: 1, panX: 0, panY: 0 },
    ),
    null,
  );
});

test("resize, zoom, and pan preserve exact viewport-to-image mapping", () => {
  const image = { width: 2400, height: 1600 };
  const view = { zoom: 2.25, panX: 73, panY: -41 };
  const before = getEditorImageLayout({ width: 900, height: 600 }, image, view)!;
  const after = getEditorImageLayout({ width: 1200, height: 760 }, image, view)!;
  const sourcePoint = { x: 1333, y: 711 };
  for (const layout of [before, after]) {
    const viewportPoint = {
      x: layout.left + (sourcePoint.x / image.width) * layout.width,
      y: layout.top + (sourcePoint.y / image.height) * layout.height,
    };
    const mapped = mapViewportPointToImage(viewportPoint, layout, image);
    assert.ok(Math.abs(mapped.x - sourcePoint.x) < 0.0001);
    assert.ok(Math.abs(mapped.y - sourcePoint.y) < 0.0001);
    assert.equal(isPointInsideImage(mapped, image), true);
  }
});

test("continuous erase and restore strokes update every crossed mask region", () => {
  const mask = new Uint8ClampedArray(30 * 12).fill(255);
  const erasedBounds = paintMaskStrokeInPlace(
    mask,
    30,
    12,
    { x: 3, y: 6 },
    { x: 26, y: 6 },
    2,
    "erase",
    1,
  );
  assert.ok(erasedBounds);
  for (let x = 3; x <= 26; x += 1) assert.equal(mask[6 * 30 + x], 0);
  paintMaskStrokeInPlace(mask, 30, 12, { x: 8, y: 6 }, { x: 15, y: 6 }, 2, "restore", 1);
  for (let x = 8; x <= 15; x += 1) assert.equal(mask[6 * 30 + x], 255);
});

test("transparent borders remain transparent in the live cutout composite", () => {
  const original = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]);
  const result = compositeOriginalWithMask(original, new Uint8ClampedArray([0, 255, 0]));
  assert.deepEqual(Array.from(result), [10, 20, 30, 0, 40, 50, 60, 255, 70, 80, 90, 0]);
});
