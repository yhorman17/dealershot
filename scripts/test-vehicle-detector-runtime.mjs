import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";

import { VEHICLE_DETECTOR_MODEL } from "./vehicle-detector-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  path.join(root, ".output", "public", "vehicle-detection", VEHICLE_DETECTOR_MODEL.filename),
  path.join(root, "public", "vehicle-detection", VEHICLE_DETECTOR_MODEL.filename),
];
let model;
for (const candidate of candidates) {
  try {
    model = await readFile(candidate);
    break;
  } catch {
    // Production output is preferred; source output supports a focused local run.
  }
}
if (!model) throw new Error("Prepared vehicle detector model is unavailable.");

const started = performance.now();
const session = await ort.InferenceSession.create(model, {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "all",
  executionMode: "sequential",
  enableCpuMemArena: true,
});
const input = new ort.Tensor("float32", new Float32Array(3 * 416 * 416), [1, 3, 416, 416]);
const outputs = await session.run({ images: input });
const output = outputs.output ?? Object.values(outputs)[0];
if (!output || output.data.length !== 3_549 * 85) {
  throw new Error("Vehicle detector production runtime returned an invalid tensor.");
}
console.log(
  `[vehicle-detector] production runtime loaded and inferred in ${Math.round(performance.now() - started)} ms`,
);
