import { useCallback, useEffect, useRef, useState } from "react";
import { CameraIcon, Images, RefreshCw, SwitchCamera, X, ZoomIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  applyCameraZoom,
  getCameraZoomPresets,
  getCameraZoomState,
  type CameraZoomRange,
} from "@/lib/camera-zoom";

type VisibleUpload = {
  id: string;
  filename: string;
  state: "queued" | "uploading" | "failed";
};

export function BulkCamera({
  capturedCount,
  uploadingCount,
  failedCount,
  uploads,
  onRetryUpload,
  onCapture,
  onDone,
  doneLabel = "Done",
}: {
  capturedCount: number;
  uploadingCount: number;
  failedCount: number;
  uploads: VisibleUpload[];
  onRetryUpload: (id: string) => void;
  onCapture: (file: File) => void;
  onDone: () => void;
  doneLabel?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [cameraState, setCameraState] = useState<"starting" | "ready" | "unavailable">("starting");
  const [capturing, setCapturing] = useState(false);
  const [zoomRange, setZoomRange] = useState<CameraZoomRange | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [zoomBusy, setZoomBusy] = useState(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    stopCamera();
    setCameraState("starting");
    setZoomRange(null);
    setZoom(null);
    void navigator.mediaDevices
      ?.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      })
      .then(async (stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const videoTrack = stream.getVideoTracks()[0];
        const zoomState = videoTrack ? getCameraZoomState(videoTrack) : null;
        setZoomRange(zoomState?.range ?? null);
        setZoom(zoomState?.value ?? null);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraState("ready");
      })
      .catch(() => {
        if (!cancelled) setCameraState("unavailable");
      });
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [facingMode, stopCamera]);

  const setHardwareZoom = async (value: number) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !zoomRange || zoomBusy) return;
    setZoomBusy(true);
    try {
      setZoom(await applyCameraZoom(track, value, zoomRange));
    } catch {
      // Device capabilities can change when the OS switches a physical lens.
      // Hide stale controls rather than presenting a slider that no longer works.
      setZoomRange(null);
      setZoom(null);
    } finally {
      setZoomBusy(false);
    }
  };

  const takePhoto = async () => {
    const video = videoRef.current;
    if (capturing || cameraState !== "ready" || !video?.videoWidth || !video.videoHeight) return;
    setCapturing(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Camera frame could not be captured.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error("Camera image could not be encoded.")),
          "image/jpeg",
          0.94,
        ),
      );
      onCapture(new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" }));
    } finally {
      setCapturing(false);
    }
  };

  const acceptFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(onCapture);
  };

  return (
    <div
      className="bulk-camera-shell fixed inset-0 z-[80] bg-black text-white"
      role="dialog"
      aria-modal
    >
      <div className="bulk-camera-header flex items-center justify-between gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div>
          <p className="text-sm font-semibold">Bulk Camera</p>
          <p className="text-xs text-white/65">
            {capturedCount} captured
            {uploadingCount > 0 ? ` · ${uploadingCount} uploading` : ""}
            {failedCount > 0 ? ` · ${failedCount} failed` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="min-h-11 bg-white text-black hover:bg-white/90"
          onClick={() => {
            stopCamera();
            onDone();
          }}
        >
          <X className="size-4" /> {doneLabel}
        </Button>
      </div>

      <div className="bulk-camera-stage relative min-h-0 flex-1 overflow-hidden bg-zinc-950">
        <video
          ref={videoRef}
          muted
          playsInline
          className="h-full w-full object-contain"
          aria-label="Live camera preview"
        />
        {cameraState !== "ready" && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div>
              {cameraState === "starting" ? (
                <RefreshCw className="mx-auto size-8 animate-spin text-white/70" />
              ) : (
                <CameraIcon className="mx-auto size-8 text-white/70" />
              )}
              <p className="mt-3 text-sm font-semibold">
                {cameraState === "starting" ? "Opening rear camera…" : "In-app camera unavailable"}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-white/60">
                {cameraState === "unavailable"
                  ? "Allow camera access, or use the photo picker below. Already uploaded photos remain safe."
                  : "DealerShot asks only when you intentionally start photo work."}
              </p>
            </div>
          </div>
        )}

        {zoomRange && zoom !== null && (
          <div className="bulk-camera-zoom absolute bottom-3 left-1/2 z-10 w-[min(21rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg bg-black/75 px-3 py-2">
            <div className="flex items-center gap-2">
              <ZoomIn className="size-4 shrink-0 text-white/75" aria-hidden />
              <input
                aria-label="Camera zoom"
                className="h-8 min-w-0 flex-1 accent-white"
                type="range"
                min={zoomRange.min}
                max={zoomRange.max}
                step={zoomRange.step}
                value={zoom}
                disabled={zoomBusy}
                onChange={(event) => void setHardwareZoom(Number(event.target.value))}
              />
              <span className="min-w-10 text-right text-xs font-semibold tabular-nums">
                {zoom.toFixed(1)}×
              </span>
            </div>
            {getCameraZoomPresets(zoomRange).length > 1 && (
              <div className="mt-1 flex justify-center gap-1.5">
                {getCameraZoomPresets(zoomRange).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={`min-h-8 min-w-10 touch-manipulation rounded-md px-2 text-xs font-semibold ${
                      Math.abs(zoom - preset) < zoomRange.step / 2
                        ? "bg-white text-black"
                        : "bg-white/15 text-white"
                    }`}
                    onClick={() => void setHardwareZoom(preset)}
                  >
                    {preset}×
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {uploads.length > 0 && (
          <div className="bulk-camera-upload-status absolute left-3 top-3 z-10 max-w-[min(18rem,45vw)] space-y-1 rounded-lg bg-black/75 p-2 text-xs">
            {uploads.slice(-3).map((upload) => (
              <div key={upload.id} className="flex min-h-8 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{upload.filename}</span>
                <span className={upload.state === "failed" ? "text-red-300" : "text-white/70"}>
                  {upload.state === "queued"
                    ? "Queued"
                    : upload.state === "uploading"
                      ? "Uploading"
                      : "Failed"}
                </span>
                {upload.state === "failed" && (
                  <button
                    type="button"
                    className="min-h-8 touch-manipulation rounded-md bg-white px-2 font-semibold text-black"
                    onClick={() => onRetryUpload(upload.id)}
                  >
                    Retry
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bulk-camera-controls grid grid-cols-[1fr_auto_1fr] items-center gap-5 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
        <label className="bulk-camera-picker justify-self-start">
          <span className="grid size-12 cursor-pointer place-items-center rounded-full bg-white/15 hover:bg-white/25">
            <Images className="size-5" />
          </span>
          <input
            className="hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={(event) => {
              acceptFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
        <button
          type="button"
          aria-label="Take photo"
          onClick={() => void takePhoto()}
          disabled={cameraState !== "ready" || capturing}
          className="bulk-camera-shutter grid size-[4.75rem] touch-manipulation place-items-center rounded-full border-4 border-white bg-white/20 disabled:opacity-40"
        >
          <span className="size-14 rounded-full bg-white" />
        </button>
        <button
          type="button"
          aria-label="Switch camera"
          onClick={() =>
            setFacingMode((current) => (current === "environment" ? "user" : "environment"))
          }
          className="grid size-12 touch-manipulation place-items-center justify-self-end rounded-full bg-white/15 hover:bg-white/25"
        >
          <SwitchCamera className="size-5" />
        </button>
      </div>
    </div>
  );
}
