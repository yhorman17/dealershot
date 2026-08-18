export type CameraZoomRange = {
  min: number;
  max: number;
  step: number;
};

type ZoomCapableTrack = Pick<
  MediaStreamTrack,
  "applyConstraints" | "getCapabilities" | "getSettings"
>;

type ZoomCapabilities = MediaTrackCapabilities & {
  zoom?: { min?: number; max?: number; step?: number };
};

type ZoomSettings = MediaTrackSettings & { zoom?: number };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function getCameraZoomState(track: ZoomCapableTrack): {
  range: CameraZoomRange;
  value: number;
} | null {
  const capability = (track.getCapabilities() as ZoomCapabilities).zoom;
  if (!capability || !finite(capability.min) || !finite(capability.max)) return null;
  if (capability.max <= capability.min) return null;

  const range = {
    min: capability.min,
    max: capability.max,
    step: finite(capability.step) && capability.step > 0 ? capability.step : 0.1,
  };
  const setting = (track.getSettings() as ZoomSettings).zoom;
  return {
    range,
    value: finite(setting) ? Math.min(range.max, Math.max(range.min, setting)) : range.min,
  };
}

export function normalizeCameraZoom(value: number, range: CameraZoomRange) {
  const clamped = Math.min(range.max, Math.max(range.min, value));
  const stepped = range.min + Math.round((clamped - range.min) / range.step) * range.step;
  return Number(Math.min(range.max, Math.max(range.min, stepped)).toFixed(3));
}

export function getCameraZoomPresets(range: CameraZoomRange) {
  return [0.5, 1, 2].filter((value) => value >= range.min && value <= range.max);
}

export async function applyCameraZoom(
  track: ZoomCapableTrack,
  value: number,
  range: CameraZoomRange,
) {
  const normalized = normalizeCameraZoom(value, range);
  await track.applyConstraints({
    advanced: [{ zoom: normalized } as MediaTrackConstraintSet],
  });
  return normalized;
}
