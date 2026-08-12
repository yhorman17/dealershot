import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Hand, Redo2, RotateCcw, Undo2 } from "lucide-react";
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
  compositeOriginalWithMask,
  getContainedImageRect,
  mapPointerToImage,
  paintMask,
  type MaskPoint,
  type MaskTool,
} from "@/lib/mask-editor";

type EditorTool = MaskTool | "pan";

async function loadImage(source: string) {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The source image could not be loaded."));
    image.src = source;
  });
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
  onApply: (blob: Blob) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const originalPixels = useRef<Uint8ClampedArray | null>(null);
  const initialMask = useRef<Uint8ClampedArray | null>(null);
  const maskRef = useRef<Uint8ClampedArray | null>(null);
  const dimensions = useRef({ width: 0, height: 0 });
  const undoStack = useRef<Uint8ClampedArray[]>([]);
  const redoStack = useRef<Uint8ClampedArray[]>([]);
  const pointer = useRef<{ id: number; last: MaskPoint; panX: number; panY: number } | null>(null);
  const [tool, setTool] = useState<EditorTool>("erase");
  const [brushSize, setBrushSize] = useState(48);
  const [hardness, setHardness] = useState(80);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const original = originalPixels.current;
    const mask = maskRef.current;
    if (!canvas || !original || !mask) return;
    const { width, height } = dimensions.current;
    const context = canvas.getContext("2d");
    if (!context) return;
    const pixels = compositeOriginalWithMask(original, mask);
    context.putImageData(new ImageData(pixels, width, height), 0, 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([loadImage(originalUrl), loadImage(cutoutUrl)])
      .then(([original, cutout]) => {
        if (cancelled) return;
        const width = original.naturalWidth;
        const height = original.naturalHeight;
        const work = document.createElement("canvas");
        work.width = width;
        work.height = height;
        const context = work.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Mask editing is unavailable in this browser.");
        context.drawImage(original, 0, 0, width, height);
        originalPixels.current = context.getImageData(0, 0, width, height).data;
        context.clearRect(0, 0, width, height);
        context.drawImage(cutout, 0, 0, width, height);
        const cutoutPixels = context.getImageData(0, 0, width, height).data;
        const mask = new Uint8ClampedArray(width * height);
        for (let index = 0; index < mask.length; index += 1)
          mask[index] = cutoutPixels[index * 4 + 3];
        maskRef.current = mask;
        initialMask.current = new Uint8ClampedArray(mask);
        dimensions.current = { width, height };
        undoStack.current = [];
        redoStack.current = [];
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = width;
          canvas.height = height;
        }
        setHistory({ undo: 0, redo: 0 });
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setLoading(false);
        requestAnimationFrame(render);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : "The mask editor could not start.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cutoutUrl, open, originalUrl, render]);

  const updateHistory = () =>
    setHistory({ undo: undoStack.current.length, redo: redoStack.current.length });

  const pushUndo = () => {
    if (!maskRef.current) return;
    undoStack.current.push(new Uint8ClampedArray(maskRef.current));
    if (undoStack.current.length > 30) undoStack.current.shift();
    redoStack.current = [];
    updateHistory();
  };

  const replaceMask = (next: Uint8ClampedArray) => {
    maskRef.current = next;
    render();
    updateHistory();
  };

  const mapEvent = (event: React.PointerEvent): MaskPoint => {
    const viewportRect = viewportRef.current!.getBoundingClientRect();
    const size = dimensions.current;
    const imageRect = getContainedImageRect(viewportRect, size);
    return mapPointerToImage({ x: event.clientX, y: event.clientY }, imageRect, size, {
      zoom,
      panX: pan.x,
      panY: pan.y,
    });
  };

  const paintAt = (point: MaskPoint) => {
    if (!maskRef.current) return;
    replaceMask(
      paintMask(
        maskRef.current,
        dimensions.current.width,
        dimensions.current.height,
        point,
        brushSize / Math.max(zoom, 0.01),
        tool as MaskTool,
        hardness / 100,
      ),
    );
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (loading || error) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = {
      id: event.pointerId,
      last: { x: event.clientX, y: event.clientY },
      panX: pan.x,
      panY: pan.y,
    };
    if (tool !== "pan") {
      pushUndo();
      paintAt(mapEvent(event));
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointer.current || pointer.current.id !== event.pointerId) return;
    if (tool === "pan") {
      setPan({
        x: pointer.current.panX + event.clientX - pointer.current.last.x,
        y: pointer.current.panY + event.clientY - pointer.current.last.y,
      });
    } else {
      paintAt(mapEvent(event));
    }
  };

  const undo = () => {
    const previous = undoStack.current.pop();
    if (!previous || !maskRef.current) return;
    redoStack.current.push(new Uint8ClampedArray(maskRef.current));
    replaceMask(previous);
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (!next || !maskRef.current) return;
    undoStack.current.push(new Uint8ClampedArray(maskRef.current));
    replaceMask(next);
  };
  const reset = () => {
    if (!maskRef.current || !initialMask.current) return;
    pushUndo();
    replaceMask(new Uint8ClampedArray(initialMask.current));
  };

  const apply = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      setError("The corrected cutout could not be rendered. Try again.");
      return;
    }
    onApply(blob);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(92dvh,58rem)] max-w-6xl grid-rows-[auto_1fr_auto] overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-14 text-left">
          <DialogTitle>Fix Cutout</DialogTitle>
          <DialogDescription>
            Erase unwanted background or restore vehicle pixels from the immutable original.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 md:grid-cols-[14rem_1fr]">
          <aside className="order-2 space-y-5 overflow-y-auto border-t border-border bg-secondary/30 p-4 md:order-1 md:border-r md:border-t-0">
            <div className="grid grid-cols-3 gap-2 md:grid-cols-1">
              <ToolButton
                active={tool === "erase"}
                onClick={() => setTool("erase")}
                icon={<Eraser />}
              >
                Erase
              </ToolButton>
              <ToolButton
                active={tool === "restore"}
                onClick={() => setTool("restore")}
                icon={<RotateCcw />}
              >
                Restore
              </ToolButton>
              <ToolButton active={tool === "pan"} onClick={() => setTool("pan")} icon={<Hand />}>
                Pan
              </ToolButton>
            </div>
            <Control label="Brush size" value={`${brushSize}px`}>
              <Slider
                value={[brushSize]}
                min={8}
                max={160}
                step={2}
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
                onValueChange={([value]) => setHardness(value)}
                aria-label="Brush hardness"
              />
            </Control>
            <Control label="Zoom" value={`${Math.round(zoom * 100)}%`}>
              <Slider
                value={[zoom]}
                min={0.5}
                max={4}
                step={0.1}
                onValueChange={([value]) => setZoom(value)}
                aria-label="Zoom"
              />
            </Control>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={undo}
                disabled={!history.undo}
                aria-label="Undo mask edit"
              >
                <Undo2 />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={redo}
                disabled={!history.redo}
                aria-label="Redo mask edit"
              >
                <Redo2 />
              </Button>
              <Button variant="outline" className="flex-1" onClick={reset}>
                Reset Mask
              </Button>
            </div>
          </aside>
          <div className="order-1 min-h-[22rem] overflow-hidden bg-[color:oklch(0.16_0.02_252)] p-3 md:order-2">
            <div
              ref={viewportRef}
              className={`relative h-full w-full touch-none overflow-hidden rounded-md [background-image:linear-gradient(45deg,#202735_25%,transparent_25%),linear-gradient(-45deg,#202735_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#202735_75%),linear-gradient(-45deg,transparent_75%,#202735_75%)] [background-position:0_0,0_10px,10px_-10px,-10px_0] [background-size:20px_20px] ${tool === "pan" ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair"}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => (pointer.current = null)}
              onPointerCancel={() => (pointer.current = null)}
            >
              <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full object-contain"
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              />
              {loading && (
                <div className="absolute inset-0 grid place-items-center bg-background/75 text-sm font-medium">
                  Preparing mask…
                </div>
              )}
              {error && (
                <div className="absolute inset-0 grid place-items-center bg-background/90 p-8 text-center text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>
        <DialogFooter className="border-t border-border px-5 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={loading || Boolean(error)}>
            Apply Mask
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToolButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      className="justify-start"
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
