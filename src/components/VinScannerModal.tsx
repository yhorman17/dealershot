import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType, type Result } from "@zxing/library";

function isValidVin(s: string): boolean {
  if (s.length !== 17) return false;
  // VINs never contain I, O, or Q
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(s);
}

export function VinScannerModal({
  onClose,
  onDetected,
}: {
  onClose: () => void;
  onDetected: (vin: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handledRef = useRef(false);
  const lastToastAtRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Configure decoder with VIN-relevant formats
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_39,
      BarcodeFormat.CODE_128,
      BarcodeFormat.DATA_MATRIX,
      BarcodeFormat.QR_CODE,
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError("No camera detected on this device.");
          return;
        }
        const video = videoRef.current;
        if (!video) return;

        // decodeFromConstraints handles getUserMedia, attaches stream to <video>,
        // and runs the decoder continuously, calling our callback for each frame.
        const controls = await reader.decodeFromConstraints(
          {
            audio: false,
            video: { facingMode: { ideal: "environment" } },
          },
          video,
          (result: Result | undefined, err: unknown) => {
            if (cancelled || handledRef.current) return;
            if (err) {
              // NotFoundException is thrown every frame with no barcode — ignore it.
              const name = (err as { name?: string })?.name;
              if (name && name !== "NotFoundException") {
                // eslint-disable-next-line no-console
                console.warn("[VIN scanner] decode error:", err);
              }
              return;
            }
            if (!result) return;
            const text = result.getText().trim().toUpperCase();
            if (!isValidVin(text)) {
              const now = Date.now();
              if (now - lastToastAtRef.current > 1200) {
                lastToastAtRef.current = now;
                showToast("Not a valid VIN — keep scanning");
              }
              return;
            }
            handledRef.current = true;
            if (navigator.vibrate) navigator.vibrate(100);
            cleanup();
            onDetected(text);
          },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;

        // Pull the live stream off the video element to control torch.
        const srcObj = video.srcObject;
        if (srcObj instanceof MediaStream) {
          streamRef.current = srcObj;
          const track = srcObj.getVideoTracks()[0];
          const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
          if (caps.torch) setTorchSupported(true);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[VIN scanner] start failed:", e);
        const err = e as DOMException;
        if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
          setError("Camera access is needed to scan VINs. Please enable camera permissions in your browser settings.");
        } else if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") {
          setError("No camera detected on this device.");
        } else {
          setError(err?.message || "Unable to start camera.");
        }
      }
    };

    const hintTimer = setTimeout(() => setHint(true), 30000);
    void start();

    return () => {
      cancelled = true;
      clearTimeout(hintTimer);
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanup() {
    try {
      controlsRef.current?.stop();
    } catch {
      /* noop */
    }
    controlsRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch { /* noop */ }
    }
  }

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1500);
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      const next = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: next } as unknown as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  }

  function handleClose() {
    cleanup();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black flex flex-col">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />
      <div className="absolute inset-0 bg-black/40 pointer-events-none" />

      {/* top bar */}
      <div className="relative flex items-center justify-between p-4 z-10">
        {torchSupported ? (
          <button
            type="button"
            onClick={() => void toggleTorch()}
            className="rounded-full bg-black/60 text-white px-3 py-2 text-sm border border-white/20"
            aria-label="Toggle flashlight"
          >
            {torchOn ? "🔦 On" : "🔦 Off"}
          </button>
        ) : (
          <div />
        )}
        <button
          type="button"
          onClick={handleClose}
          className="rounded-full bg-black/60 text-white w-10 h-10 flex items-center justify-center border border-white/20"
          aria-label="Close scanner"
        >
          ✕
        </button>
      </div>

      {/* guide */}
      <div className="relative flex-1 flex flex-col items-center justify-center px-4 z-10">
        {error ? (
          <div className="bg-card text-card-foreground rounded-lg p-5 max-w-sm text-sm space-y-3">
            <p>{error}</p>
            <button onClick={handleClose} className="rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm w-full">
              Close
            </button>
          </div>
        ) : (
          <>
            <div
              className="rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
              style={{ width: "80vw", height: "120px" }}
            />
            <p className="mt-6 text-white text-sm text-center max-w-xs">
              Align the VIN barcode within the frame. Hold steady.
            </p>
            {hint && (
              <div className="mt-4 bg-card text-card-foreground rounded-lg p-4 max-w-sm text-xs space-y-3">
                <p>Trouble scanning? Try better lighting or hold the phone closer. You can also type the VIN manually below.</p>
                <button onClick={handleClose} className="rounded-md border border-border bg-secondary text-secondary-foreground px-3 py-2 text-sm w-full">
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* toast */}
      {toast && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-destructive text-destructive-foreground text-xs px-3 py-2 rounded-md z-20">
          {toast}
        </div>
      )}
    </div>
  );
}
