import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKGROUND_REMOVAL_SOURCE,
  selectBackgroundRemovalResources,
  sha256,
  uniqueBackgroundRemovalChunks,
} from "./background-removal-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "public", "background-removal");

async function fetchRequired(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok)
    throw new Error(`Background-removal asset request failed (${response.status}).`);
  return response;
}

async function existingChunkIsValid(file, expectedHash) {
  try {
    return sha256(await readFile(file)) === expectedHash;
  } catch {
    return false;
  }
}

export async function prepareBackgroundRemovalAssets() {
  const manifestResponse = await fetchRequired(`${BACKGROUND_REMOVAL_SOURCE}resources.json`);
  const upstreamManifest = await manifestResponse.json();
  const manifest = selectBackgroundRemovalResources(upstreamManifest);
  const chunks = uniqueBackgroundRemovalChunks(manifest);

  await mkdir(outputDirectory, { recursive: true });
  const expectedFiles = new Set(["resources.json", ...chunks.map((chunk) => chunk.name)]);
  for (const entry of await import("node:fs/promises").then(({ readdir }) =>
    readdir(outputDirectory),
  )) {
    if (!expectedFiles.has(entry)) await rm(path.join(outputDirectory, entry), { force: true });
  }

  let downloaded = 0;
  for (const chunk of chunks) {
    const destination = path.join(outputDirectory, chunk.name);
    if (await existingChunkIsValid(destination, chunk.hash)) continue;

    const response = await fetchRequired(`${BACKGROUND_REMOVAL_SOURCE}${chunk.name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== chunk.hash) {
      throw new Error(`Downloaded background-removal asset failed checksum: ${chunk.name}.`);
    }
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
    downloaded += 1;
  }

  await writeFile(
    path.join(outputDirectory, "resources.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `[background-removal] prepared ${chunks.length} verified chunks (${downloaded} downloaded)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await prepareBackgroundRemovalAssets();
}
