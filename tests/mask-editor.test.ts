import test from "node:test";
import assert from "node:assert/strict";
import {
  compositeOriginalWithMask,
  getContainedImageRect,
  mapPointerToImage,
  paintMask,
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
