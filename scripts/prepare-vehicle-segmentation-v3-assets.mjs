import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  VEHICLE_SEGMENTATION_V3_ASSETS,
  verifyVehicleSegmentationV3Asset,
} from "./vehicle-segmentation-v3-assets.mjs";

const source = process.env.DEALERSHOT_V3_MODEL_SOURCE_DIR;
if (!source) {
  throw new Error(
    "Set DEALERSHOT_V3_MODEL_SOURCE_DIR to the explicitly exported, pinned V3 asset directory.",
  );
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "public", "vehicle-segmentation-v3");
await mkdir(destination, { recursive: true });
for (const asset of VEHICLE_SEGMENTATION_V3_ASSETS) {
  const bytes = await readFile(path.join(source, asset.filename));
  verifyVehicleSegmentationV3Asset(asset, bytes);
  await copyFile(path.join(source, asset.filename), path.join(destination, asset.filename));
}
console.log("[vehicle-segmentation-v3] copied four pinned, verified experimental assets");
