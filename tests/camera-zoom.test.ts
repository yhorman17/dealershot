import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCameraZoom,
  getCameraZoomPresets,
  getCameraZoomState,
  normalizeCameraZoom,
} from "../src/lib/camera-zoom.ts";

test("hardware zoom capability is detected and respects device bounds", () => {
  const track = {
    getCapabilities: () => ({ zoom: { min: 1, max: 4, step: 0.25 } }),
    getSettings: () => ({ zoom: 2 }),
    applyConstraints: async () => undefined,
  } as unknown as MediaStreamTrack;
  assert.deepEqual(getCameraZoomState(track), {
    range: { min: 1, max: 4, step: 0.25 },
    value: 2,
  });
  assert.equal(normalizeCameraZoom(9, { min: 1, max: 4, step: 0.25 }), 4);
  assert.deepEqual(getCameraZoomPresets({ min: 1, max: 4, step: 0.25 }), [1, 2]);
});

test("unsupported zoom is hidden instead of presenting fake controls", () => {
  const track = {
    getCapabilities: () => ({}),
    getSettings: () => ({}),
    applyConstraints: async () => undefined,
  } as unknown as MediaStreamTrack;
  assert.equal(getCameraZoomState(track), null);
});

test("zoom uses the active video track constraint and device step", async () => {
  let constraints: MediaTrackConstraints | undefined;
  const track = {
    getCapabilities: () => ({ zoom: { min: 1, max: 3, step: 0.5 } }),
    getSettings: () => ({ zoom: 1 }),
    applyConstraints: async (value: MediaTrackConstraints) => {
      constraints = value;
    },
  } as unknown as MediaStreamTrack;
  const applied = await applyCameraZoom(track, 1.74, { min: 1, max: 3, step: 0.5 });
  assert.equal(applied, 1.5);
  assert.deepEqual(constraints?.advanced, [{ zoom: 1.5 }]);
});
