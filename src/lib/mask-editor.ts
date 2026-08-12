export type MaskTool = "erase" | "restore";
export type MaskPoint = { x: number; y: number };

export function getContainedImageRect(
  container: { left: number; top: number; width: number; height: number },
  image: { width: number; height: number },
) {
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    left: container.left + (container.width - width) / 2,
    top: container.top + (container.height - height) / 2,
    width,
    height,
  };
}

export function mapPointerToImage(
  client: MaskPoint,
  canvasRect: { left: number; top: number; width: number; height: number },
  image: { width: number; height: number },
  view: { zoom: number; panX: number; panY: number },
): MaskPoint {
  const displayWidth = canvasRect.width * view.zoom;
  const displayHeight = canvasRect.height * view.zoom;
  const localX = client.x - canvasRect.left - view.panX - (canvasRect.width - displayWidth) / 2;
  const localY = client.y - canvasRect.top - view.panY - (canvasRect.height - displayHeight) / 2;
  return {
    x: (localX / displayWidth) * image.width,
    y: (localY / displayHeight) * image.height,
  };
}

export function paintMask(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  point: MaskPoint,
  radius: number,
  tool: MaskTool,
  hardness = 0.8,
) {
  const next = new Uint8ClampedArray(mask);
  const safeRadius = Math.max(1, radius);
  const inner = safeRadius * Math.min(1, Math.max(0, hardness));
  const minX = Math.max(0, Math.floor(point.x - safeRadius));
  const maxX = Math.min(width - 1, Math.ceil(point.x + safeRadius));
  const minY = Math.max(0, Math.floor(point.y - safeRadius));
  const maxY = Math.min(height - 1, Math.ceil(point.y + safeRadius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x - point.x, y - point.y);
      if (distance > safeRadius) continue;
      const strength =
        distance <= inner || inner === safeRadius
          ? 1
          : 1 - (distance - inner) / Math.max(1, safeRadius - inner);
      const index = y * width + x;
      next[index] =
        tool === "erase"
          ? Math.round(next[index] * (1 - strength))
          : Math.round(next[index] + (255 - next[index]) * strength);
    }
  }
  return next;
}

export function compositeOriginalWithMask(original: Uint8ClampedArray, mask: Uint8ClampedArray) {
  if (original.length !== mask.length * 4) throw new Error("Mask dimensions do not match image.");
  const output = new Uint8ClampedArray(original);
  for (let index = 0; index < mask.length; index += 1) output[index * 4 + 3] = mask[index];
  return output;
}
