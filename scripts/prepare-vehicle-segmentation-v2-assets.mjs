import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  VEHICLE_SEGMENTATION_V2_MODEL,
  verifyVehicleSegmentationV2Bytes,
} from "./vehicle-segmentation-v2-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "public", "vehicle-segmentation-v2");
const destination = path.join(outputDirectory, VEHICLE_SEGMENTATION_V2_MODEL.filename);

async function existingModelIsValid() {
  try {
    verifyVehicleSegmentationV2Bytes(await readFile(destination));
    return true;
  } catch {
    return false;
  }
}

export async function prepareVehicleSegmentationV2Assets() {
  await mkdir(outputDirectory, { recursive: true });
  if (await existingModelIsValid()) {
    console.log("[vehicle-segmentation-v2] pinned model already verified");
    return;
  }
  const response = await fetch(VEHICLE_SEGMENTATION_V2_MODEL.source, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`V2 model request failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyVehicleSegmentationV2Bytes(bytes);
  const temporary = `${destination}.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  console.log(`[vehicle-segmentation-v2] prepared ${bytes.length} verified bytes`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await prepareVehicleSegmentationV2Assets();
}
