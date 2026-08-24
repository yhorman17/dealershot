import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  VEHICLE_SEGMENTATION_V3_ASSETS,
  verifyVehicleSegmentationV3Asset,
} from "./vehicle-segmentation-v3-assets.mjs";

const root = process.cwd();
const modelDirectory = path.resolve(
  process.env.DEALERSHOT_V3_MODEL_DIR ?? "worker-assets/vehicle-segmentation-v3",
);
const childPath = path.resolve(process.env.DEALERSHOT_V3_CHILD_PATH ?? ".worker-v3/child.mjs");
const fixturePath = path.resolve("scripts/vehicle-segmentation-v3-runtime-fixture.jpg");

for (const asset of VEHICLE_SEGMENTATION_V3_ASSETS) {
  verifyVehicleSegmentationV3Asset(
    asset,
    await readFile(path.join(modelDirectory, asset.filename)),
  );
}

const directory = await mkdtemp(path.join(tmpdir(), "dealershot-v3-runtime-verify-"));
try {
  const requestPath = path.join(directory, "request.json");
  const resultPath = path.join(directory, "result.json");
  const outputPrefix = path.join(directory, "cutout");
  await writeFile(requestPath, JSON.stringify({ sourcePath: fixturePath, outputPrefix }));

  const stderr = [];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, requestPath, resultPath], {
      cwd: root,
      env: {
        ...process.env,
        DEALERSHOT_V3_MODEL_DIR: modelDirectory,
        VEHICLE_SEGMENTATION_V3: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `Production V3 child failed (${exitCode}): ${Buffer.concat(stderr).toString("utf8").slice(-2_000)}`,
    );
  }

  const result = JSON.parse(await readFile(resultPath, "utf8"));
  if (result.error || !result.outputs?.selected) {
    throw new Error(
      `Production V3 child produced no usable cutout: ${result.error ?? "no output"}`,
    );
  }
  if (result.eligibility?.classification !== "FULL_VEHICLE" || result.ambiguous) {
    throw new Error("Production V3 child did not identify the fixture as one complete vehicle.");
  }
  const output = await readFile(result.outputs.selected);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!output.subarray(0, 8).equals(pngSignature) || output[25] !== 6) {
    throw new Error("Production V3 child output is not an RGBA PNG.");
  }
  if (!Number.isFinite(result.quality?.score) || result.quality.score < 0.5) {
    throw new Error("Production V3 child output failed the conservative mask-quality floor.");
  }

  console.log(
    `[vehicle-segmentation-v3] production child verified: ${result.quality.rating} ` +
      `score=${result.quality.score.toFixed(4)} bytes=${output.length}`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
