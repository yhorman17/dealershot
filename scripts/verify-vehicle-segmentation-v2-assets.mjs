import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  VEHICLE_SEGMENTATION_V2_MODEL,
  verifyVehicleSegmentationV2Bytes,
} from "./vehicle-segmentation-v2-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(
  root,
  "public",
  "vehicle-segmentation-v2",
  VEHICLE_SEGMENTATION_V2_MODEL.filename,
);
verifyVehicleSegmentationV2Bytes(await readFile(source));
console.log("[vehicle-segmentation-v2] pinned source asset verified");
