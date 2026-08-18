import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BACKGROUND_REMOVAL_RESOURCE_KEYS,
  selectBackgroundRemovalResources,
  uniqueBackgroundRemovalChunks,
} from "../scripts/background-removal-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("production background removal selects only the quantized model and CPU runtime", () => {
  const fixture = Object.fromEntries(
    [...BACKGROUND_REMOVAL_RESOURCE_KEYS, "/models/isnet", "/unrelated"].map((key, index) => [
      key,
      {
        size: 4,
        chunks: [
          {
            name: `${index}`.padStart(64, "a"),
            hash: `${index}`.padStart(64, "a"),
            offsets: [0, 4] as [number, number],
          },
        ],
      },
    ]),
  );
  const selected = selectBackgroundRemovalResources(fixture);
  assert.deepEqual(Object.keys(selected), BACKGROUND_REMOVAL_RESOURCE_KEYS);
  assert.equal(uniqueBackgroundRemovalChunks(selected).length, 3);
});

test("browser inference uses same-origin verified assets and stays lazy", () => {
  const helper = read("src/lib/background-removal.ts");
  const editor = read("src/components/BackgroundEditor.tsx");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(helper, /new URL\(BACKGROUND_REMOVAL_ASSET_ROUTE, origin\)/);
  assert.match(helper, /publicPath: backgroundRemovalPublicPath\(\)/);
  assert.match(helper, /await import\("@imgly\/background-removal"\)/);
  assert.match(helper, /model: "isnet_quint8"/);
  assert.match(helper, /output\.type !== "image\/png" \|\| output\.size === 0/);
  assert.match(editor, /removeVehicleBackground\(/);
  assert.doesNotMatch(editor, /staticimgly\.com/);
  assert.equal(packageJson.dependencies["onnxruntime-web"], "1.21.0");
  assert.match(packageJson.scripts.build, /prepare-background-removal-assets/);
  assert.match(packageJson.scripts.build, /verify-background-removal-assets/);
});

test("asset preparation verifies every downloaded chunk by SHA-256", () => {
  const prepare = read("scripts/prepare-background-removal-assets.mjs");
  const verify = read("scripts/verify-background-removal-assets.mjs");
  assert.match(prepare, /sha256\(bytes\) !== chunk\.hash/);
  assert.match(prepare, /writeFile\(temporary, bytes\)/);
  assert.match(verify, /verifyChunkFile/);
  assert.match(verify, /reconstructedBytes !== entry\.size/);
});

test("browser smoke fixture rejects a uniform mask and records transparency", () => {
  const smoke = read("tests/fixtures/background-removal-smoke.ts");
  const config = read("tests/fixtures/vite.background-removal-smoke.config.mjs");
  assert.match(smoke, /await removeVehicleBackground\(source/);
  assert.match(smoke, /mode"\) === "default"/);
  assert.match(smoke, /requestedSize\.split\("x"\)/);
  assert.match(smoke, /minimumAlpha === maximumAlpha/);
  assert.match(smoke, /statusElement\.dataset\.minimumAlpha/);
  assert.match(smoke, /statusElement\.dataset\.maximumAlpha/);
  assert.match(smoke, /statusElement\.dataset\.result = "passed"/);
  assert.match(config, /publicDir: path\.resolve\(fixtureDirectory, "\.\.", "\.\.", "public"\)/);
});
