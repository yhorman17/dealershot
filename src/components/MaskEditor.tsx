import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Eraser,
  Eye,
  Hand,
  LoaderCircle,
  Maximize2,
  Redo2,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import {
  getEditorImageLayout,
  isPointInsideImage,
  mapViewportPointToImage,
  paintMaskStrokeInPlace,
  type EditorImageLayout,
  type MaskDirtyRect,
  type MaskPoint,
  type MaskTool,
} from "@/lib/mask-editor";

type EditorTool = MaskTool | "pan";
type EditorPhase = "loading" | "ready" | "error" | "applying";
type LoadedImage = {
  canvas: HTMLCanvasElement;
  pixels: ImageData;
  width: number;
  height: number;
};
type PointerSession = {
  id: number;
  lastClient: MaskPoint;
  lastImage: MaskPoint | null;
  startPan: MaskPoint;
};

async function decodeImageSource(
  source: string,
  label: "original photo" | "current cutout",
  signal: AbortSignal,
): Promise<LoadedImage> {
  const response = await fetch(source, {
    cache: "no-store",
    credentials: "omit",
    mode: "cors",
    signal,
  });
  if (!response.ok) throw new Error(`The ${label} could not be downloaded (${response.status}).`);
  const blob = await response.blob();
  if (!blob.size) throw new Error(`The ${label} is empty.`);

  const objectUrl = URL.createObjectURL(blob);
  let bitmap: ImageBitmap | null = null;
  try {
    let decoded: CanvasImageSource;
    let decodedWidth: number;
    let decodedHeight: number;
    if (typeof createImageBitmap === "function") {
      bitmap = await createImageBitmap(blob);
      decoded = bitmap;
      decodedWidth = bitmap.width;
      decodedHeight = bitmap.height;
    } else {
      const image = new Image();
      image.decoding = "async";
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error(`The ${label} took too long to decode.`)),
          15_000,
        );
        image.onload = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        image.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error(`The ${label} could not be decoded.`));
        };
        image.src = objectUrl;
      });
      decoded = image;
      decodedWidth = image.naturalWidth;
      decodedHeight = image.naturalHeight;
    }
    if (!decodedWidth || !decodedHeight) throw new Error(`The ${label} has invalid dimensions.`);

    const canvas = document.createElement("canvas");
    canvas.width = decodedWidth;
    canvas.height = decodedHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Mask editing is unavailable in this browser.");
    context.drawImage(decoded, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return { canvas, pixels, width: canvas.width, height: canvas.height };
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "SecurityError")
      throw new Error("The browser blocked pixel access to this photo.");
    if (reason instanceof Error) throw reason;
    throw new Error(`The ${label} could not be decoded.`);
  } finally {
    bitmap?.close();
    URL.revokeObjectURL(objectUrl);
  }
}

export function MaskEditor({
  originalUrl,
  cutoutUrl,
  open,
  onOpenChange,
  onApply,
}: {
  originalUrl: string;
  cutoutUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (blob: Blob) => void | Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const initialMaskRef = useRef<Uint8ClampedArray | null>(null);
  const maskRef = useRef<Uint8ClampedArray | null>(null);
  const dimensionsRef = useRef({ width: 0, height: 0 });
  const undoStackRef = useRef<Uint8ClampedArray[]>([]);
  const redoStackRef = useRef<Uint8ClampedArray[]>([]);
  const historyLimitRef = useRef(4);
  const pointerRef = useRef<PointerSession | null>(null);
  const renderFrameRef = useRef<number | null>(null);
  const [tool, setTool] = useState<EditorTool>("erase");
  const [brushSize, setBrushSize] = useState(44);
  const [hardness, setHardness] = useState(80);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const [phase, setPhase] = useState<EditorPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [assetVersion, setAssetVersion] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0, dpr: 1 });
  const [cursor, setCursor] = useState({ x: 0, y: 0, visible: false });

  const updateHistory = useCallback(
    () =>
      setHistory({
        undo: undoStackRef.current.length,
        redo: redoStackRef.current.length,
      }),
    [],
  );

  const setViewportNode = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    setViewportElement((current) => (current === node ? current : node));
  }, []);

  const syncMaskCanvas = useCallback((dirty?: MaskDirtyRect) => {
    const mask = maskRef.current;
    const { width, height } = dimensionsRef.current;
    if (!mask || !width || !height) return;
    let canvas = maskCanvasRef.current;
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      maskCanvasRef.current = canvas;
      dirty = { left: 0, top: 0, width, height };
    }
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The editable mask could not be rendered.");
    const region = dirty ?? { left: 0, top: 0, width, height };
    const image = context.createImageData(region.width, region.height);
    for (let y = 0; y < region.height; y += 1) {
      for (let x = 0; x < region.width; x += 1) {
        const sourceIndex = (region.top + y) * width + region.left + x;
        const targetIndex = (y * region.width + x) * 4;
        image.data[targetIndex] = 255;
        image.data[targetIndex + 1] = 255;
        image.data[targetIndex + 2] = 255;
        image.data[targetIndex + 3] = mask[sourceIndex];
      }
    }
    context.putImageData(image, region.left, region.top);
  }, []);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    const source = sourceCanvasRef.current;
    const mask = maskCanvasRef.current;
    const dimensions = dimensionsRef.current;
    if (!canvas || !viewport || !source || !mask || !dimensions.width || !dimensions.height) return;

    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (width <= 0 || height <= 0) return;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The photo preview could not be rendered.");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const layout = getEditorImageLayout(
      { width, height },
      dimensions,
      { zoom, panX: pan.x, panY: pan.y },
      24,
    );
    if (!layout) return;
    context.globalCompositeOperation = "source-over";
    context.drawImage(source, layout.left, layout.top, layout.width, layout.height);
    if (!showOriginal) {
      context.globalCompositeOperation = "destination-in";
      context.drawImage(mask, layout.left, layout.top, layout.width, layout.height);
      context.globalCompositeOperation = "source-over";
    }
  }, [pan.x, pan.y, showOriginal, zoom]);

  const requestRender = useCallback(() => {
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = requestAnimationFrame(() => {
      renderFrameRef.current = null;
      try {
        renderCanvas();
      } catch (reason) {
        console.error(
          "[mask-editor] preview rendering failed",
          reason instanceof Error ? reason.message : "Unknown rendering error",
        );
        setError("Fix Cutout couldn't render this photo.");
        setPhase("error");
      }
    });
  }, [renderCanvas]);

  useLayoutEffect(() => {
    if (!open || !viewportElement) return;
    const viewport = viewportElement;
    const measure = () => {
      const rect = viewport.getBoundingClientRect();
      const next = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        dpr: Math.min(3, Math.max(1, window.devicePixelRatio || 1)),
      };
      if (next.width <= 0 || next.height <= 0) return;
      setViewportSize((current) =>
        current.width === next.width && current.height === next.height && current.dpr === next.dpr
          ? current
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    window.addEventListener("resize", measure);
    const frame = requestAnimationFrame(measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, viewportElement]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let cancelled = false;
    setPhase("loading");
    setError(null);
    setApplyError(null);
    setAssetVersion(0);
    setShowOriginal(false);
    setCursor((current) => ({ ...current, visible: false }));
    pointerRef.current = null;

    void Promise.all([
      decodeImageSource(originalUrl, "original photo", controller.signal),
      decodeImageSource(cutoutUrl, "current cutout", controller.signal),
    ])
      .then(([original, cutout]) => {
        if (cancelled) return;
        const width = original.width;
        const height = original.height;
        const cutoutCanvas = document.createElement("canvas");
        cutoutCanvas.width = width;
        cutoutCanvas.height = height;
        const cutoutContext = cutoutCanvas.getContext("2d", { willReadFrequently: true });
        if (!cutoutContext) throw new Error("The current cutout could not be inspected.");
        cutoutContext.drawImage(cutout.canvas, 0, 0, width, height);
        const cutoutPixels = cutoutContext.getImageData(0, 0, width, height).data;
        const mask = new Uint8ClampedArray(width * height);
        for (let index = 0; index < mask.length; index += 1)
          mask[index] = cutoutPixels[index * 4 + 3];

        sourceCanvasRef.current = original.canvas;
        dimensionsRef.current = { width, height };
        maskRef.current = mask;
        initialMaskRef.current = new Uint8ClampedArray(mask);
        undoStackRef.current = [];
        redoStackRef.current = [];
        // Full-mask snapshots are bounded to roughly 48 MB per history direction.
        historyLimitRef.current = Math.max(
          2,
          Math.min(12, Math.floor((48 * 1024 * 1024) / Math.max(1, mask.byteLength))),
        );
        syncMaskCanvas();
        updateHistory();
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setAssetVersion((value) => value + 1);
      })
      .catch((reason: unknown) => {
        if (cancelled || (reason instanceof DOMException && reason.name === "AbortError")) return;
        console.error(
          "[mask-editor] photo initialization failed",
          reason instanceof Error ? reason.message : "Unknown initialization error",
        );
        setError(
          reason instanceof Error
            ? reason.message
            : "We couldn't load this photo for cutout editing.",
        );
        setPhase("error");
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (renderFrameRef.current !== null) cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
      pointerRef.current = null;
      sourceCanvasRef.current = null;
      maskCanvasRef.current = null;
      maskRef.current = null;
      initialMaskRef.current = null;
      undoStackRef.current = [];
      redoStackRef.current = [];
    };
  }, [cutoutUrl, open, originalUrl, retryNonce, syncMaskCanvas, updateHistory]);

  useEffect(() => {
    if (!open || !assetVersion || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    setPhase((current) => (current === "loading" ? "ready" : current));
    requestRender();
  }, [assetVersion, open, requestRender, viewportSize]);

  useEffect(() => {
    if (phase === "ready" || phase === "applying") requestRender();
  }, [phase, requestRender, viewportSize]);

  useEffect(() => {
    if (!open) return;
    const redraw = () => {
      if (document.visibilityState === "visible") requestRender();
    };
    document.addEventListener("visibilitychange", redraw);
    return () => document.removeEventListener("visibilitychange", redraw);
  }, [open, requestRender]);

  const getPointerData = (event: React.PointerEvent) => {
    const viewport = viewportRef.current;
    const dimensions = dimensionsRef.current;
    if (!viewport) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const local = { x: event.clientX - viewportRect.left, y: event.clientY - viewportRect.top };
    const layout = getEditorImageLayout(
      { width: viewportRect.width, height: viewportRect.height },
      dimensions,
      { zoom, panX: pan.x, panY: pan.y },
      24,
    );
    if (!layout) return null;
    const image = mapViewportPointToImage(local, layout, dimensions);
    return { local, image, layout };
  };

  const pushUndo = () => {
    if (!maskRef.current) return;
    undoStackRef.current.push(new Uint8ClampedArray(maskRef.current));
    while (undoStackRef.current.length > historyLimitRef.current) undoStackRef.current.shift();
    redoStackRef.current = [];
    updateHistory();
  };

  const paintStroke = (
    from: MaskPoint,
    to: MaskPoint,
    layout: EditorImageLayout,
    activeTool: MaskTool,
  ) => {
    const mask = maskRef.current;
    const dimensions = dimensionsRef.current;
    if (!mask) return;
    const dirty = paintMaskStrokeInPlace(
      mask,
      dimensions.width,
      dimensions.height,
      from,
      to,
      brushSize / Math.max(layout.scale, 0.0001),
      activeTool,
      hardness / 100,
    );
    if (!dirty) return;
    syncMaskCanvas(dirty);
    requestRender();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (phase !== "ready" || showOriginal) return;
    const data = getPointerData(event);
    if (!data) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = {
      id: event.pointerId,
      lastClient: { x: event.clientX, y: event.clientY },
      lastImage: isPointInsideImage(data.image, dimensionsRef.current) ? data.image : null,
      startPan: pan,
    };
    if (tool !== "pan" && pointerRef.current.lastImage) {
      pushUndo();
      paintStroke(pointerRef.current.lastImage, pointerRef.current.lastImage, data.layout, tool);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const data = getPointerData(event);
    if (data)
      setCursor({
        x: data.local.x,
        y: data.local.y,
        visible:
          phase === "ready" &&
          !showOriginal &&
          tool !== "pan" &&
          isPointInsideImage(data.image, dimensionsRef.current),
      });
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId || !data) return;
    if (tool === "pan") {
      setPan({
        x: pointer.startPan.x + event.clientX - pointer.lastClient.x,
        y: pointer.startPan.y + event.clientY - pointer.lastClient.y,
      });
      return;
    }
    if (!pointer.lastImage) {
      if (isPointInsideImage(data.image, dimensionsRef.current)) pointer.lastImage = data.image;
      return;
    }
    paintStroke(pointer.lastImage, data.image, data.layout, tool);
    pointer.lastImage = data.image;
  };

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    pointerRef.current = null;
  };

  const replaceMask = (next: Uint8ClampedArray) => {
    maskRef.current = next;
    syncMaskCanvas();
    updateHistory();
    requestRender();
  };

  const undo = () => {
    const previous = undoStackRef.current.pop();
    if (!previous || !maskRef.current) return;
    redoStackRef.current.push(new Uint8ClampedArray(maskRef.current));
    while (redoStackRef.current.length > historyLimitRef.current) redoStackRef.current.shift();
    replaceMask(previous);
  };

  const redo = () => {
    const next = redoStackRef.current.pop();
    if (!next || !maskRef.current) return;
    undoStackRef.current.push(new Uint8ClampedArray(maskRef.current));
    while (undoStackRef.current.length > historyLimitRef.current) undoStackRef.current.shift();
    replaceMask(next);
  };

  const reset = () => {
    if (!maskRef.current || !initialMaskRef.current) return;
    pushUndo();
    replaceMask(new Uint8ClampedArray(initialMaskRef.current));
  };

  const fit = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const apply = async () => {
    const source = sourceCanvasRef.current;
    const mask = maskCanvasRef.current;
    const dimensions = dimensionsRef.current;
    if (phase !== "ready" || !source || !mask) return;
    setPhase("applying");
    setApplyError(null);
    try {
      const output = document.createElement("canvas");
      output.width = dimensions.width;
      output.height = dimensions.height;
      const context = output.getContext("2d");
      if (!context) throw new Error("The corrected cutout could not be rendered.");
      context.drawImage(source, 0, 0);
      context.globalCompositeOperation = "destination-in";
      context.drawImage(mask, 0, 0);
      context.globalCompositeOperation = "source-over";
      const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("The corrected cutout could not be encoded.");
      await onApply(blob);
      onOpenChange(false);
    } catch (reason) {
      console.error(
        "[mask-editor] applying corrected mask failed",
        reason instanceof Error ? reason.message : "Unknown apply error",
      );
      setApplyError(
        reason instanceof Error ? reason.message : "The corrected cutout could not be applied.",
      );
      setPhase("ready");
    }
  };

  const controlsDisabled = phase !== "ready";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && phase === "applying") return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="grid h-[min(92dvh,58rem)] max-w-[min(96vw,90rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-14 text-left">
          <div className="flex items-start justify-between gap-5">
            <div>
              <DialogTitle>Fix Cutout</DialogTitle>
              <DialogDescription className="mt-1.5">
                Erase unwanted background or restore vehicle pixels from the immutable original.
              </DialogDescription>
            </div>
            <span className="mr-5 hidden rounded-md bg-secondary px-2 py-1 text-[11px] font-medium text-muted-foreground sm:inline-flex">
              {showOriginal ? "Original preview" : "Cutout preview"}
            </span>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 grid-rows-[minmax(18rem,1fr)_minmax(0,auto)] md:grid-cols-[minmax(0,3fr)_minmax(14rem,1fr)] md:grid-rows-1">
          <section className="min-h-0 bg-[color:oklch(0.18_0.015_252)] p-3 sm:p-4">
            <div
              ref={setViewportNode}
              data-testid="mask-editor-viewport"
              className={`relative h-full min-h-[18rem] w-full touch-none overflow-hidden rounded-lg border border-white/10 shadow-inner [background-color:#d9dde4] [background-image:linear-gradient(45deg,#b8bec8_25%,transparent_25%),linear-gradient(-45deg,#b8bec8_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#b8bec8_75%),linear-gradient(-45deg,transparent_75%,#b8bec8_75%)] [background-position:0_0,0_14px,14px_-14px,-14px_0] [background-size:28px_28px] ${phase !== "ready" ? "cursor-default" : tool === "pan" ? "cursor-grab active:cursor-grabbing" : "cursor-none"}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={finishPointer}
              onPointerCancel={finishPointer}
              onPointerLeave={() => {
                if (!pointerRef.current) setCursor((current) => ({ ...current, visible: false }));
              }}
            >
              <canvas
                ref={canvasRef}
                data-testid="mask-editor-canvas"
                className="absolute inset-0 h-full w-full"
                aria-label="Editable vehicle cutout preview"
              />
              {cursor.visible && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute left-0 top-0 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.8),0_1px_6px_rgba(0,0,0,0.45)]"
                  style={{
                    width: brushSize * 2,
                    height: brushSize * 2,
                    transform: `translate(${cursor.x - brushSize}px, ${cursor.y - brushSize}px)`,
                  }}
                />
              )}
              {phase === "loading" && (
                <div
                  data-testid="mask-editor-loading"
                  className="absolute inset-0 grid place-items-center bg-background/88 p-8 text-center"
                  aria-live="polite"
                >
                  <div>
                    <LoaderCircle className="mx-auto size-6 animate-spin text-primary motion-reduce:animate-none" />
                    <p className="mt-3 text-sm font-semibold">Loading photo and cutout…</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Editing starts after both images decode and the viewport is ready.
                    </p>
                  </div>
                </div>
              )}
              {phase === "error" && (
                <div
                  data-testid="mask-editor-error"
                  className="absolute inset-0 grid place-items-center bg-background/94 p-8 text-center"
                  role="alert"
                >
                  <div className="max-w-sm">
                    <AlertTriangle className="mx-auto size-7 text-destructive" />
                    <p className="mt-3 text-sm font-semibold">Fix Cutout couldn't start.</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {error ?? "We couldn't load this photo for cutout editing."}
                    </p>
                    <div className="mt-5 flex justify-center gap-2">
                      <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Close
                      </Button>
                      <Button onClick={() => setRetryNonce((value) => value + 1)}>Try Again</Button>
                    </div>
                  </div>
                </div>
              )}
              {phase === "applying" && (
                <div className="absolute inset-0 grid place-items-center bg-background/75 text-center">
                  <div>
                    <LoaderCircle className="mx-auto size-6 animate-spin text-primary motion-reduce:animate-none" />
                    <p className="mt-3 text-sm font-semibold">Applying corrected mask…</p>
                  </div>
                </div>
              )}
            </div>
          </section>

          <aside className="max-h-[17rem] space-y-4 overflow-y-auto border-t border-border bg-secondary/25 p-4 md:max-h-none md:border-l md:border-t-0">
            <div className="grid grid-cols-3 gap-2 md:grid-cols-1">
              <ToolButton
                active={tool === "erase"}
                disabled={controlsDisabled || showOriginal}
                onClick={() => setTool("erase")}
                icon={<Eraser />}
              >
                Erase
              </ToolButton>
              <ToolButton
                active={tool === "restore"}
                disabled={controlsDisabled || showOriginal}
                onClick={() => setTool("restore")}
                icon={<RotateCcw />}
              >
                Restore
              </ToolButton>
              <ToolButton
                active={tool === "pan"}
                disabled={controlsDisabled}
                onClick={() => setTool("pan")}
                icon={<Hand />}
              >
                Pan
              </ToolButton>
            </div>

            <Button
              type="button"
              variant={showOriginal ? "secondary" : "outline"}
              className="w-full justify-start"
              disabled={controlsDisabled}
              onClick={() => setShowOriginal((value) => !value)}
            >
              <Eye className="size-4" /> {showOriginal ? "Show cutout" : "Preview original"}
            </Button>

            <Control label="Brush size" value={`${brushSize}px`}>
              <Slider
                value={[brushSize]}
                min={8}
                max={120}
                step={2}
                disabled={controlsDisabled || showOriginal}
                onValueChange={([value]) => setBrushSize(value)}
                aria-label="Brush size"
              />
            </Control>
            <Control label="Brush hardness" value={`${hardness}%`}>
              <Slider
                value={[hardness]}
                min={20}
                max={100}
                step={5}
                disabled={controlsDisabled || showOriginal}
                onValueChange={([value]) => setHardness(value)}
                aria-label="Brush hardness"
              />
            </Control>
            <Control label="Zoom" value={`${Math.round(zoom * 100)}%`}>
              <Slider
                value={[zoom]}
                min={0.5}
                max={6}
                step={0.1}
                disabled={controlsDisabled}
                onValueChange={([value]) => setZoom(value)}
                aria-label="Zoom"
              />
            </Control>

            <div className="grid grid-cols-4 gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={undo}
                disabled={controlsDisabled || !history.undo}
                aria-label="Undo mask edit"
              >
                <Undo2 />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={redo}
                disabled={controlsDisabled || !history.redo}
                aria-label="Redo mask edit"
              >
                <Redo2 />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={fit}
                disabled={controlsDisabled}
                aria-label="Fit photo in viewport"
              >
                <Maximize2 />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={reset}
                disabled={controlsDisabled}
                aria-label="Reset mask"
              >
                <RotateCcw />
              </Button>
            </div>

            {applyError && (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/8 p-3 text-xs text-destructive"
                role="alert"
              >
                {applyError} Your edited mask is still open; try Apply Mask again.
              </div>
            )}
          </aside>
        </div>

        <DialogFooter className="border-t border-border px-5 py-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={phase === "applying"}
          >
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={phase !== "ready"}>
            Apply Mask
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToolButton({
  active,
  disabled,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      className="justify-start"
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {children}
    </Button>
  );
}

function Control({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
      </div>
      {children}
    </div>
  );
}
