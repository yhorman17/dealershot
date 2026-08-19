import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { VehicleSegmentationV3Result } from "./vehicle-segmentation-v3.ts";

const MAX_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 45_000;
let active = 0;
const waiting: Array<() => void> = [];

async function acquire() {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release() {
  active -= 1;
  waiting.shift()?.();
}

function runChild(requestPath: string, resultPath: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const builtScript = process.env.DEALERSHOT_V3_CHILD_PATH;
    const script = builtScript
      ? path.resolve(builtScript)
      : path.resolve("scripts", "run-vehicle-segmentation-v3-child.mjs");
    const childArguments = builtScript
      ? [script, requestPath, resultPath]
      : ["--experimental-strip-types", script, requestPath, resultPath];
    const child = spawn(process.execPath, childArguments, {
      cwd: process.cwd(),
      env: { ...process.env, VEHICLE_SEGMENTATION_V3: "1" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-4_000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("vehicle_segmentation_v3_child_timeout"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`vehicle_segmentation_v3_child_failed:${diagnostics.trim()}`));
    });
  });
}

export type IsolatedVehicleSegmentationV3Result = VehicleSegmentationV3Result & {
  memory: { rssBefore: number; rssAfterInference: number; rssAfterRelease: number };
};

export async function runVehicleSegmentationV3Isolated(
  source: Buffer,
  options: { timeoutMs?: number } = {},
): Promise<IsolatedVehicleSegmentationV3Result> {
  await acquire();
  const directory = await mkdtemp(path.join(tmpdir(), "dealershot-v3-child-"));
  try {
    const sourcePath = path.join(directory, "source-image");
    const requestPath = path.join(directory, "request.json");
    const resultPath = path.join(directory, "result.json");
    const outputPrefix = path.join(directory, "cutout");
    await Promise.all([
      writeFile(sourcePath, source),
      writeFile(requestPath, JSON.stringify({ sourcePath, outputPrefix })),
    ]);
    await runChild(requestPath, resultPath, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const serialized = JSON.parse(await readFile(resultPath, "utf8"));
    if (serialized.error) throw new Error(serialized.error);
    const [bytes, rawBytes, refinedBytes] = await Promise.all([
      serialized.outputs.selected ? readFile(serialized.outputs.selected) : null,
      serialized.outputs.raw ? readFile(serialized.outputs.raw) : null,
      serialized.outputs.refined ? readFile(serialized.outputs.refined) : null,
    ]);
    delete serialized.outputs;
    return { ...serialized, bytes, rawBytes, refinedBytes };
  } finally {
    await rm(directory, { recursive: true, force: true });
    release();
  }
}
