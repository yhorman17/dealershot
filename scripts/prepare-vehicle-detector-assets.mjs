import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VEHICLE_DETECTOR_MODEL, verifyVehicleDetectorBytes } from "./vehicle-detector-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "public", "vehicle-detection");
const destination = path.join(outputDirectory, VEHICLE_DETECTOR_MODEL.filename);

async function existingModelIsValid() {
  try {
    verifyVehicleDetectorBytes(await readFile(destination));
    return true;
  } catch {
    return false;
  }
}

export async function prepareVehicleDetectorAssets() {
  await mkdir(outputDirectory, { recursive: true });
  if (await existingModelIsValid()) {
    console.log("[vehicle-detector] pinned YOLOX-Nano asset already verified");
    return;
  }

  const response = await fetch(VEHICLE_DETECTOR_MODEL.source, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Vehicle detector asset request failed (${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyVehicleDetectorBytes(bytes);
  const temporary = `${destination}.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  console.log(`[vehicle-detector] prepared ${bytes.length} verified bytes`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await prepareVehicleDetectorAssets();
}
