import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VEHICLE_DETECTOR_MODEL, verifyVehicleDetectorBytes } from "./vehicle-detector-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = path.join(
  root,
  ".output",
  "public",
  "vehicle-detection",
  VEHICLE_DETECTOR_MODEL.filename,
);

export async function verifyVehicleDetectorAssets() {
  const bytes = await readFile(modelPath);
  verifyVehicleDetectorBytes(bytes);
  console.log(
    `[vehicle-detector] production package verified: ${VEHICLE_DETECTOR_MODEL.model} ${bytes.length} bytes`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await verifyVehicleDetectorAssets();
}
