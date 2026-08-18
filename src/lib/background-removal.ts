export const BACKGROUND_REMOVAL_ASSET_ROUTE = "/background-removal/";

export type BackgroundRemovalProgress = (key: string, current: number, total: number) => void;

export function backgroundRemovalPublicPath(origin = window.location.origin): string {
  return new URL(BACKGROUND_REMOVAL_ASSET_ROUTE, origin).toString();
}

export async function removeVehicleBackground(
  source: Blob,
  progress?: BackgroundRemovalProgress,
): Promise<Blob> {
  const { removeBackground } = await import("@imgly/background-removal");
  const output = await removeBackground(source, {
    publicPath: backgroundRemovalPublicPath(),
    model: "isnet_quint8",
    debug: false,
    output: { format: "image/png", quality: 1 },
    progress,
  });
  if (output.type !== "image/png" || output.size === 0) {
    throw new Error("Background removal returned an invalid PNG output.");
  }
  return output;
}
