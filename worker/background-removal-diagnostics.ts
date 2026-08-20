export type BackgroundFailureCategory =
  | "transient"
  | "source_invalid"
  | "model_rejection"
  | "resource_failure"
  | "finalization_failure";

export type SafeMaskDiagnostics = {
  sample_width: number;
  sample_height: number;
  alpha_min: number;
  alpha_max: number;
  alpha_mean: number;
  foreground_coverage: number;
  alpha_range: number;
  component_count: number;
  largest_component_ratio: number;
  edge_contact_ratio: number;
  hole_ratio: number;
  entropy: number;
  bounding_box: { x: number; y: number; width: number; height: number } | null;
  reasons: string[];
  draft_usable: boolean;
};

export type MaskQuality = "good" | "needs_review" | "bad";

export class BackgroundProcessingError extends Error {
  readonly category: BackgroundFailureCategory;
  readonly retryable: boolean;
  readonly diagnostics: Record<string, unknown>;

  constructor(
    code: string,
    category: BackgroundFailureCategory,
    retryable: boolean,
    diagnostics: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "BackgroundProcessingError";
    this.category = category;
    this.retryable = retryable;
    this.diagnostics = diagnostics;
  }
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

function connectedComponents(mask: Uint8Array, width: number, height: number) {
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const sizes: number[] = [];
  let label = 0;

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    label += 1;
    let head = 0;
    let tail = 0;
    let size = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const index = queue[head++];
      size += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ];
      for (const next of neighbors) {
        if (next >= 0 && mask[next] && !labels[next]) {
          labels[next] = label;
          queue[tail++] = next;
        }
      }
    }
    sizes.push(size);
  }
  return sizes;
}

function enclosedHolePixels(mask: Uint8Array, width: number, height: number) {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let holes = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    let size = 0;
    let touchesEdge = false;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      size += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ];
      for (const next of neighbors) {
        if (next >= 0 && !mask[next] && !seen[next]) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    if (!touchesEdge) holes += size;
  }
  return holes;
}

export function analyzeBackgroundMask(alpha: Uint8Array, width: number, height: number) {
  if (width < 1 || height < 1 || alpha.length !== width * height) {
    throw new BackgroundProcessingError(
      "background_mask_diagnostics_invalid",
      "model_rejection",
      false,
    );
  }

  const binary = new Uint8Array(alpha.length);
  const histogram = new Uint32Array(16);
  let foreground = 0;
  let minimum = 255;
  let maximum = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let edgeForeground = 0;
  let alphaTotal = 0;
  const edgePixels = Math.max(1, width * 2 + Math.max(0, height - 2) * 2);

  for (let index = 0; index < alpha.length; index += 1) {
    const value = alpha[index];
    histogram[Math.min(15, Math.floor(value / 16))] += 1;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    alphaTotal += value;
    if (value < 16) continue;
    binary[index] = 1;
    foreground += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edgeForeground += 1;
  }

  const coverage = foreground / alpha.length;
  const components = connectedComponents(binary, width, height).sort((a, b) => b - a);
  const largestComponentRatio = foreground > 0 ? (components[0] ?? 0) / foreground : 0;
  const holes = foreground > 0 ? enclosedHolePixels(binary, width, height) / foreground : 0;
  let entropy = 0;
  for (const count of histogram) {
    if (!count) continue;
    const probability = count / alpha.length;
    entropy -= probability * Math.log2(probability);
  }
  entropy /= 4;

  const reasons: string[] = [];
  const alphaRange = maximum - minimum;
  if (foreground === 0) reasons.push("no_foreground");
  if (coverage >= 0.995) reasons.push("foreground_covers_image");
  if (alphaRange < 8) reasons.push("uniform_mask");
  if (coverage > 0 && coverage < 0.02) reasons.push("foreground_too_small");
  if (coverage > 0.94 && coverage < 0.995) reasons.push("foreground_too_large");
  if (foreground > 0 && largestComponentRatio < 0.65) reasons.push("fragmented_mask");
  if (edgeForeground / edgePixels > 0.6) reasons.push("excessive_edge_contact");
  if (holes > 0.35) reasons.push("excessive_holes");
  if (entropy < 0.015) reasons.push("low_mask_entropy");

  const draftUsable =
    coverage >= 0.005 && coverage <= 0.985 && alphaRange >= 8 && largestComponentRatio >= 0.2;
  const hardFailure =
    foreground === 0 || coverage >= 0.995 || alphaRange < 8 || largestComponentRatio < 0.2;
  const quality: MaskQuality = hardFailure ? "bad" : reasons.length > 0 ? "needs_review" : "good";

  const diagnostics: SafeMaskDiagnostics = {
    sample_width: width,
    sample_height: height,
    alpha_min: minimum,
    alpha_max: maximum,
    alpha_mean: round(alphaTotal / alpha.length),
    foreground_coverage: round(coverage),
    alpha_range: alphaRange,
    component_count: components.length,
    largest_component_ratio: round(largestComponentRatio),
    edge_contact_ratio: round(edgeForeground / edgePixels),
    hole_ratio: round(holes),
    entropy: round(entropy),
    bounding_box:
      maxX >= minX && maxY >= minY
        ? {
            x: round(minX / width),
            y: round(minY / height),
            width: round((maxX - minX + 1) / width),
            height: round((maxY - minY + 1) / height),
          }
        : null,
    reasons,
    draft_usable: draftUsable,
  };
  return { quality, diagnostics };
}

export function classifyBackgroundFailure(error: unknown) {
  if (error instanceof BackgroundProcessingError) {
    return {
      code: error.message,
      category: error.category,
      retryable: error.retryable,
      diagnostics: error.diagnostics,
    };
  }
  const message = error instanceof Error ? error.message.trim() : "";
  const safeName =
    error instanceof Error && error.name !== "Error" && /^[a-z][a-z0-9_-]{2,63}$/i.test(error.name)
      ? error.name.toLowerCase()
      : "unknown_error";
  const code = /^[a-z][a-z0-9_.-]{2,119}$/i.test(message) ? message.toLowerCase() : safeName;
  if (
    ["storage_download_failed", "background_source_lookup_failed", "job_lease_lost"].includes(code)
  ) {
    return { code, category: "transient" as const, retryable: true, diagnostics: {} };
  }
  if (
    [
      "storage_upload_failed",
      "storage_verification_failed",
      "background_variant_finalize_failed",
    ].includes(code)
  ) {
    return { code, category: "finalization_failure" as const, retryable: true, diagnostics: {} };
  }
  if (
    ["invalid_media_size", "unsupported_media_type", "background_source_decode_failed"].includes(
      code,
    )
  ) {
    return { code, category: "source_invalid" as const, retryable: false, diagnostics: {} };
  }
  if (code.startsWith("background_mask_") || code.startsWith("background_inference_mask_")) {
    return { code, category: "model_rejection" as const, retryable: false, diagnostics: {} };
  }
  if (
    code.startsWith("background_model_") ||
    code === "background_runtime_unavailable" ||
    code === "background_inference_runtime_failed"
  ) {
    return { code, category: "resource_failure" as const, retryable: false, diagnostics: {} };
  }
  return { code, category: "transient" as const, retryable: true, diagnostics: {} };
}
