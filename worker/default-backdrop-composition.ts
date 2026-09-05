import sharp from "sharp";

import {
  analyzeVehicleAlpha,
  buildAmbientShadowFootprint,
  buildContactShadowLobes,
  buildGroundEffectProfile,
  buildGroundPlaneGeometry,
  buildGroundReflectionSlices,
  PREPARED_IMAGE_HEIGHT,
  PREPARED_IMAGE_WIDTH,
  type BackdropFloorFinish,
} from "../src/lib/vehicle-ground-effects.ts";

const clampInt = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

function svgNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "0";
}

function pathData(points: Array<{ x: number; y: number }>) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${svgNumber(point.x)} ${svgNumber(point.y)}`)
    .join(" ");
}

async function renderReflection(
  cutout: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  slices: ReturnType<typeof buildGroundReflectionSlices>,
  bounds: { left: number; right: number },
  opacity: number,
) {
  if (!slices.length || opacity <= 0) return null;
  const inputs: Parameters<ReturnType<typeof sharp>["composite"]>[0] = [];
  const left = clampInt(bounds.left, 0, sourceWidth - 1);
  const width = clampInt(bounds.right - bounds.left + 1, 1, sourceWidth - left);

  for (const slice of slices) {
    const top = clampInt(slice.sourceTop, 0, sourceHeight - 1);
    const height = clampInt(slice.sourceHeight, 1, sourceHeight - top);
    const destinationWidth = clampInt(slice.destinationWidth, 1, PREPARED_IMAGE_WIDTH);
    const destinationHeight = clampInt(slice.destinationHeight, 1, PREPARED_IMAGE_HEIGHT);
    const resized = await sharp(cutout)
      .extract({ left, top, width, height })
      .resize(destinationWidth, destinationHeight, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaMultiplier = opacity * slice.opacity;
    for (let index = 3; index < resized.data.length; index += 4) {
      resized.data[index] = Math.round((resized.data[index] ?? 0) * alphaMultiplier);
    }
    const sliceBytes = await sharp(resized.data, {
      raw: { width: destinationWidth, height: destinationHeight, channels: 4 },
    })
      .blur(Math.max(0.3, slice.blur))
      .png()
      .toBuffer();
    inputs.push({
      input: sliceBytes,
      left: clampInt(slice.destinationX, 0, PREPARED_IMAGE_WIDTH - destinationWidth),
      top: clampInt(slice.destinationY, 0, PREPARED_IMAGE_HEIGHT - destinationHeight),
      blend: "over",
    });
  }

  return sharp({
    create: {
      width: PREPARED_IMAGE_WIDTH,
      height: PREPARED_IMAGE_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(inputs)
    .png()
    .toBuffer();
}

export async function composeDefaultProcessedPhoto(input: {
  cutout: Buffer;
  backdrop: Buffer;
  shotType?: string | null;
  floorFinish?: BackdropFloorFinish | null;
}) {
  const raw = await sharp(input.cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (raw.info.channels !== 4) throw new Error("default_composition_cutout_alpha_unavailable");
  const analysis = analyzeVehicleAlpha(
    Uint8ClampedArray.from(raw.data),
    raw.info.width,
    raw.info.height,
    input.shotType,
  );
  if (analysis.alphaCoverage <= 0) throw new Error("default_composition_cutout_empty");

  const profile = buildGroundEffectProfile(analysis, input.floorFinish ?? "semi_gloss");
  const geometry = buildGroundPlaneGeometry(
    raw.info.width,
    raw.info.height,
    analysis,
    PREPARED_IMAGE_WIDTH,
    PREPARED_IMAGE_HEIGHT,
  );
  const footprint = buildAmbientShadowFootprint(geometry, profile, profile.shadow.scale);
  const contactLobes = buildContactShadowLobes(
    geometry,
    profile,
    profile.shadow.opacity / 100,
    profile.shadow.scale,
  );
  const reflectionSlices = buildGroundReflectionSlices(
    analysis,
    geometry,
    profile,
    profile.reflection.scale,
  );
  const reflection = await renderReflection(
    input.cutout,
    raw.info.width,
    raw.info.height,
    reflectionSlices,
    analysis.bounds,
    profile.reflection.opacity / 100,
  );

  const ambientDepth = Math.max(18, geometry.vehicleHeight * profile.shadow.depthFactor);
  const contactMarkup = contactLobes
    .map(
      (lobe, index) =>
        `<ellipse cx="${svgNumber(lobe.centerX)}" cy="${svgNumber(lobe.centerY)}" rx="${svgNumber(lobe.radiusX)}" ry="${svgNumber(lobe.radiusY)}" fill="url(#contact-${index})"/>`,
    )
    .join("");
  const contactDefs = contactLobes
    .map(
      (lobe, index) =>
        `<radialGradient id="contact-${index}"><stop offset="0" stop-color="#090b0d" stop-opacity="${svgNumber(lobe.coreOpacity)}"/><stop offset="0.5" stop-color="#111418" stop-opacity="${svgNumber(lobe.midOpacity)}"/><stop offset="1" stop-color="#111418" stop-opacity="0"/></radialGradient>`,
    )
    .join("");
  const shadowSvg =
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PREPARED_IMAGE_WIDTH}" height="${PREPARED_IMAGE_HEIGHT}">
    <defs>
      <linearGradient id="ambient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#15181b" stop-opacity="${svgNumber((profile.shadow.opacity / 100) * 0.36)}"/>
        <stop offset="0.4" stop-color="#1d2023" stop-opacity="${svgNumber((profile.shadow.opacity / 100) * 0.21)}"/>
        <stop offset="1" stop-color="#1d2023" stop-opacity="0"/>
      </linearGradient>
      ${contactDefs}
      <filter id="ambient-blur"><feGaussianBlur stdDeviation="${svgNumber(Math.max(5, geometry.vehicleWidth * profile.shadow.blurFactor))}"/></filter>
    </defs>
    <path d="${pathData(footprint)} Z" fill="url(#ambient)" filter="url(#ambient-blur)"/>
    ${contactMarkup}
  </svg>`);

  const bounds = analysis.bounds;
  const cropLeft = clampInt(bounds.left, 0, raw.info.width - 1);
  const cropTop = clampInt(bounds.top, 0, raw.info.height - 1);
  const cropWidth = clampInt(bounds.right - bounds.left + 1, 1, raw.info.width - cropLeft);
  const cropHeight = clampInt(bounds.bottom - bounds.top + 1, 1, raw.info.height - cropTop);
  const vehicleWidth = clampInt(
    geometry.frame.visibleBounds.right - geometry.frame.visibleBounds.left,
    1,
    PREPARED_IMAGE_WIDTH,
  );
  const vehicleHeight = clampInt(
    geometry.frame.visibleBounds.bottom - geometry.frame.visibleBounds.top,
    1,
    PREPARED_IMAGE_HEIGHT,
  );
  const vehicle = await sharp(input.cutout)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .resize(vehicleWidth, vehicleHeight, { fit: "fill" })
    .png()
    .toBuffer();
  const vehicleLeft = clampInt(
    geometry.frame.visibleBounds.left,
    0,
    PREPARED_IMAGE_WIDTH - vehicleWidth,
  );
  const vehicleTop = clampInt(
    geometry.frame.visibleBounds.top,
    0,
    PREPARED_IMAGE_HEIGHT - vehicleHeight,
  );
  const overlays: Parameters<ReturnType<typeof sharp>["composite"]>[0] = [];
  if (reflection) overlays.push({ input: reflection, left: 0, top: 0 });
  overlays.push({ input: shadowSvg, left: 0, top: 0 });
  overlays.push({ input: vehicle, left: vehicleLeft, top: vehicleTop });

  const bytes = await sharp(input.backdrop)
    .rotate()
    .resize(PREPARED_IMAGE_WIDTH, PREPARED_IMAGE_HEIGHT, { fit: "cover" })
    .composite(overlays)
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();

  return {
    bytes,
    analysis,
    profile,
    frame: geometry.frame,
    grounding: {
      version: "ground-plane-v3",
      floor_finish: profile.floorFinish,
      contact_zones: geometry.contactZones.length,
      contact_confidence: geometry.contactConfidence,
      reflection_enabled: reflectionSlices.length > 0,
      ambient_depth: ambientDepth,
      projection_direction: geometry.projectionDirection,
    },
  };
}
