import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createVehicleSegmentationV2Cutout,
  releaseVehicleSegmentationV2Runtime,
} from "../worker/vehicle-segmentation-v2.ts";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = argument("--image") ?? path.join(root, "public", "placeholder.svg");
const source = await readFile(image);
const rssBefore = process.memoryUsage().rss;
const started = performance.now();
const result = await createVehicleSegmentationV2Cutout(source);
const completedAt = performance.now();
const rssAfterInference = process.memoryUsage().rss;
await releaseVehicleSegmentationV2Runtime();
if (global.gc) global.gc();
await new Promise((resolve) => setTimeout(resolve, 100));
const rssAfterRelease = process.memoryUsage().rss;

console.log(
  JSON.stringify(
    {
      image: path.basename(image),
      milliseconds: Math.round(completedAt - started),
      eligibility: result.eligibility.classification,
      candidateCount: result.candidateCount,
      quality: result.quality.rating,
      outputBytes: result.bytes?.length ?? 0,
      rssBefore,
      rssAfterInference,
      rssAfterRelease,
      incrementalPeakRssBytes: Math.max(0, process.resourceUsage().maxRSS * 1024 - rssBefore),
    },
    null,
    2,
  ),
);
