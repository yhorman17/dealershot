import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const BACKGROUND_REMOVAL_VERSION = "1.7.0";
export const BACKGROUND_REMOVAL_SOURCE = `https://staticimgly.com/@imgly/background-removal-data/${BACKGROUND_REMOVAL_VERSION}/dist/`;
export const BACKGROUND_REMOVAL_RESOURCE_KEYS = [
  "/models/isnet_quint8",
  "/onnxruntime-web/ort-wasm-simd-threaded.wasm",
  "/onnxruntime-web/ort-wasm-simd-threaded.mjs",
];

export function selectBackgroundRemovalResources(manifest) {
  const selected = {};
  for (const key of BACKGROUND_REMOVAL_RESOURCE_KEYS) {
    const entry = manifest[key];
    if (!entry || !Number.isSafeInteger(entry.size) || !Array.isArray(entry.chunks)) {
      throw new Error(`IMG.LY resource manifest is missing ${key}.`);
    }
    selected[key] = entry;
  }
  return selected;
}

export function uniqueBackgroundRemovalChunks(manifest) {
  const chunks = new Map();
  for (const entry of Object.values(manifest)) {
    for (const chunk of entry.chunks) {
      if (!/^[a-f0-9]{64}$/.test(chunk.name) || chunk.hash !== chunk.name) {
        throw new Error(`IMG.LY resource chunk has an invalid SHA-256 identity: ${chunk.name}.`);
      }
      chunks.set(chunk.name, chunk);
    }
  }
  return [...chunks.values()];
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyChunkFile(directory, chunk) {
  const bytes = await readFile(path.join(directory, chunk.name));
  const actual = sha256(bytes);
  if (actual !== chunk.hash) {
    throw new Error(`Background-removal asset checksum mismatch for ${chunk.name}.`);
  }
  return bytes.length;
}
