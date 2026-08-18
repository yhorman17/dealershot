import { removeVehicleBackground } from "../../src/lib/background-removal";

const sourceUrl =
  "https://upload.wikimedia.org/wikipedia/commons/4/42/VW_Tiguan_Sport%26Style_2.0_TDI_4Motion_Deep_Black_Facelift_Front.JPG";

const status = document.querySelector<HTMLParagraphElement>("#status");
const canvas = document.querySelector<HTMLCanvasElement>("#result");

if (!status || !canvas) throw new Error("Smoke-test document is incomplete.");
const statusElement = status;
const resultCanvas = canvas;

async function run() {
  try {
    const sourceResponse = await fetch(sourceUrl, { mode: "cors" });
    if (!sourceResponse.ok) throw new Error(`Fixture request failed (${sourceResponse.status}).`);
    let source = await sourceResponse.blob();
    const requestedSize = new URLSearchParams(window.location.search).get("size");
    if (requestedSize) {
      const [requestedWidth, requestedHeight] = requestedSize.split("x").map(Number);
      if (requestedWidth > 0 && requestedHeight > 0) {
        const image = await createImageBitmap(source);
        const sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = requestedWidth;
        sourceCanvas.height = requestedHeight;
        sourceCanvas.getContext("2d")?.drawImage(image, 0, 0, requestedWidth, requestedHeight);
        image.close();
        source = await new Promise<Blob>((resolve, reject) =>
          sourceCanvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("Fixture resize failed."))),
            "image/jpeg",
            0.92,
          ),
        );
      }
    }
    statusElement.textContent = `Source loaded (${source.size} bytes); loading production model…`;

    const progress = (key: string, current: number, total: number) => {
      const percent = total > 0 ? Math.round((current / total) * 100) : 0;
      statusElement.textContent = `${key}: ${percent}%`;
    };
    const useUpstreamDefault =
      new URLSearchParams(window.location.search).get("mode") === "default";
    const output = useUpstreamDefault
      ? await import("@imgly/background-removal").then(({ removeBackground }) =>
          removeBackground(source, {
            model: "isnet_quint8",
            output: { format: "image/png", quality: 1 },
            progress,
          }),
        )
      : await removeVehicleBackground(source, progress);
    const image = await createImageBitmap(output);
    resultCanvas.width = image.width;
    resultCanvas.height = image.height;
    const context = resultCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(image, 0, 0);
    image.close();

    const pixels = context.getImageData(0, 0, resultCanvas.width, resultCanvas.height).data;
    let minimumAlpha = 255;
    let maximumAlpha = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      minimumAlpha = Math.min(minimumAlpha, pixels[index]);
      maximumAlpha = Math.max(maximumAlpha, pixels[index]);
    }
    if (minimumAlpha === maximumAlpha) {
      throw new Error(`Segmentation mask is uniform (${minimumAlpha}).`);
    }

    statusElement.dataset.result = "passed";
    statusElement.dataset.outputBytes = String(output.size);
    statusElement.dataset.width = String(resultCanvas.width);
    statusElement.dataset.height = String(resultCanvas.height);
    statusElement.dataset.minimumAlpha = String(minimumAlpha);
    statusElement.dataset.maximumAlpha = String(maximumAlpha);
    statusElement.textContent = `PASS: ${resultCanvas.width}×${resultCanvas.height}, ${output.size} bytes, alpha ${minimumAlpha}–${maximumAlpha}`;
  } catch (reason) {
    statusElement.dataset.result = "failed";
    statusElement.textContent =
      reason instanceof Error ? reason.message : "Unknown smoke-test failure.";
    console.error("[background-removal-smoke] failed", reason);
  }
}

void run();
