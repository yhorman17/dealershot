import { readFile, writeFile } from "node:fs/promises";

import {
  createVehicleSegmentationV3Cutout,
  releaseVehicleSegmentationV3Runtime,
} from "../worker/vehicle-segmentation-v3.ts";

const [requestPath, resultPath] = process.argv.slice(2);
if (!requestPath || !resultPath) throw new Error("V3 child requires request and result paths.");

const request = JSON.parse(await readFile(requestPath, "utf8"));
const rssBefore = process.memoryUsage().rss;
try {
  const source = await readFile(request.sourcePath);
  const result = await createVehicleSegmentationV3Cutout(source);
  const rssAfterInference = process.memoryUsage().rss;
  const outputs = {};
  for (const [name, bytes] of [
    ["selected", result.bytes],
    ["raw", result.rawBytes],
    ["refined", result.refinedBytes],
  ]) {
    if (!bytes) continue;
    const outputPath = `${request.outputPrefix}-${name}.png`;
    await writeFile(outputPath, bytes);
    outputs[name] = outputPath;
  }
  const serializable = {
    ...result,
    bytes: undefined,
    rawBytes: undefined,
    refinedBytes: undefined,
    outputs,
    memory: { rssBefore, rssAfterInference },
  };
  await releaseVehicleSegmentationV3Runtime();
  serializable.memory.rssAfterRelease = process.memoryUsage().rss;
  await writeFile(resultPath, JSON.stringify(serializable));
} catch (error) {
  await releaseVehicleSegmentationV3Runtime().catch(() => undefined);
  await writeFile(
    resultPath,
    JSON.stringify({
      error: error instanceof Error ? error.message : "vehicle_segmentation_v3_child_failed",
      memory: { rssBefore, rssAfterFailure: process.memoryUsage().rss },
    }),
  );
  process.exitCode = 1;
}
