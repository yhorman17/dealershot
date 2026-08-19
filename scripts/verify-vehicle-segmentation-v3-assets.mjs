import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  VEHICLE_SEGMENTATION_V3_ASSETS,
  verifyVehicleSegmentationV3Asset,
} from "./vehicle-segmentation-v3-assets.mjs";

const directory = path.resolve("public", "vehicle-segmentation-v3");
for (const asset of VEHICLE_SEGMENTATION_V3_ASSETS) {
  verifyVehicleSegmentationV3Asset(asset, await readFile(path.join(directory, asset.filename)));
}
console.log("[vehicle-segmentation-v3] four pinned experimental assets verified");
