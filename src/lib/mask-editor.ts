export type MaskTool = "erase" | "restore";
export type MaskPoint = { x: number; y: number };
export type MaskDirtyRect = { left: number; top: number; width: number; height: number };

export type EditorImageLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
};

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

export function getEditorImageLayout(
  viewport: { width: number; height: number },
  image: { width: number; height: number },
  view: { zoom: number; panX: number; panY: number },
  padding = 24,
): EditorImageLayout | null {
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0)
    return null;

  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const fitScale = Math.min(availableWidth / image.width, availableHeight / image.height);
  const zoom = Math.min(6, Math.max(0.5, view.zoom));
  const scale = fitScale * zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    left: (viewport.width - width) / 2 + view.panX,
    top: (viewport.height - height) / 2 + view.panY,
    width,
    height,
    scale,
  };
}

export function mapViewportPointToImage(
  viewportPoint: MaskPoint,
  layout: EditorImageLayout,
  image: { width: number; height: number },
): MaskPoint {
  return {
    x: ((viewportPoint.x - layout.left) / layout.width) * image.width,
    y: ((viewportPoint.y - layout.top) / layout.height) * image.height,
  };
}

export function isPointInsideImage(point: MaskPoint, image: { width: number; height: number }) {
  return point.x >= 0 && point.y >= 0 && point.x <= image.width && point.y <= image.height;
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
  paintMaskStrokeInPlace(next, width, height, point, point, radius, tool, hardness);
  return next;
}

export function paintMaskStrokeInPlace(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  from: MaskPoint,
  to: MaskPoint,
  radius: number,
  tool: MaskTool,
  hardness = 0.8,
): MaskDirtyRect | null {
  const safeRadius = Math.max(1, radius);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, safeRadius * 0.35)));
  let dirty: MaskDirtyRect | null = null;

  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    const point = {
      x: from.x + (to.x - from.x) * ratio,
      y: from.y + (to.y - from.y) * ratio,
    };
    const changed = paintMaskPointInPlace(mask, width, height, point, safeRadius, tool, hardness);
    if (!changed) continue;
    if (!dirty) dirty = changed;
    else {
      const right = Math.max(dirty.left + dirty.width, changed.left + changed.width);
      const bottom = Math.max(dirty.top + dirty.height, changed.top + changed.height);
      dirty.left = Math.min(dirty.left, changed.left);
      dirty.top = Math.min(dirty.top, changed.top);
      dirty.width = right - dirty.left;
      dirty.height = bottom - dirty.top;
    }
  }
  return dirty;
}

function paintMaskPointInPlace(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  point: MaskPoint,
  safeRadius: number,
  tool: MaskTool,
  hardness: number,
): MaskDirtyRect | null {
  const inner = safeRadius * Math.min(1, Math.max(0, hardness));
  const minX = Math.max(0, Math.floor(point.x - safeRadius));
  const maxX = Math.min(width - 1, Math.ceil(point.x + safeRadius));
  const minY = Math.max(0, Math.floor(point.y - safeRadius));
  const maxY = Math.min(height - 1, Math.ceil(point.y + safeRadius));
  if (minX > maxX || minY > maxY) return null;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x - point.x, y - point.y);
      if (distance > safeRadius) continue;
      const strength =
        distance <= inner || inner === safeRadius
          ? 1
          : 1 - (distance - inner) / Math.max(1, safeRadius - inner);
      const index = y * width + x;
      mask[index] =
        tool === "erase"
          ? Math.round(mask[index] * (1 - strength))
          : Math.round(mask[index] + (255 - mask[index]) * strength);
    }
  }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function compositeOriginalWithMask(original: Uint8ClampedArray, mask: Uint8ClampedArray) {
  if (original.length !== mask.length * 4) throw new Error("Mask dimensions do not match image.");
  const output = new Uint8ClampedArray(original);
  for (let index = 0; index < mask.length; index += 1) output[index * 4 + 3] = mask[index];
  return output;
}
