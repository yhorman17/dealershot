import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKGROUND_REMOVAL_RESOURCE_KEYS,
  selectBackgroundRemovalResources,
  uniqueBackgroundRemovalChunks,
  verifyChunkFile,
} from "./background-removal-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(root, ".output", "public", "background-removal");

export async function verifyBackgroundRemovalAssets() {
  const manifest = selectBackgroundRemovalResources(
    JSON.parse(await readFile(path.join(publicDirectory, "resources.json"), "utf8")),
  );
  const chunks = uniqueBackgroundRemovalChunks(manifest);
  let totalBytes = 0;
  for (const chunk of chunks) totalBytes += await verifyChunkFile(publicDirectory, chunk);

  for (const key of BACKGROUND_REMOVAL_RESOURCE_KEYS) {
    const entry = manifest[key];
    const reconstructedBytes = entry.chunks.reduce(
      (total, chunk) => total + chunk.offsets[1] - chunk.offsets[0],
      0,
    );
    if (reconstructedBytes !== entry.size) {
      throw new Error(`Background-removal resource size mismatch for ${key}.`);
    }
  }

  console.log(
    `[background-removal] production package verified: ${chunks.length} chunks, ${totalBytes} bytes`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await verifyBackgroundRemovalAssets();
}
