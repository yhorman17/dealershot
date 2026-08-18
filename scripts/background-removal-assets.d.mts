export const BACKGROUND_REMOVAL_VERSION: string;
export const BACKGROUND_REMOVAL_SOURCE: string;
export const BACKGROUND_REMOVAL_RESOURCE_KEYS: string[];

export type BackgroundRemovalChunk = {
  name: string;
  hash: string;
  offsets: [number, number];
};

export type BackgroundRemovalResource = {
  size: number;
  chunks: BackgroundRemovalChunk[];
};

export function selectBackgroundRemovalResources(
  manifest: Record<string, BackgroundRemovalResource>,
): Record<string, BackgroundRemovalResource>;

export function uniqueBackgroundRemovalChunks(
  manifest: Record<string, BackgroundRemovalResource>,
): BackgroundRemovalChunk[];

export function sha256(bytes: Uint8Array): string;
export function verifyChunkFile(directory: string, chunk: BackgroundRemovalChunk): Promise<number>;
