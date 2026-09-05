import sharp from "sharp";

import {
  analyzeVehicleAlpha,
  buildAmbientShadowFootprint,
  buildGroundEffectProfile,
  buildGroundPlaneGeometry,
  buildGroundReflectionSlices,
  PREPARED_IMAGE_HEIGHT,
  PREPARED_IMAGE_WIDTH,
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
    const sliceBytes = await sharp(cutout)
      .extract({ left, top, width, height })
      .resize(destinationWidth, destinationHeight, { fit: "fill" })
      .png()
      .toBuffer();
    inputs.push({
      input: sliceBytes,
      left: clampInt(slice.destinationX, 0, PREPARED_IMAGE_WIDTH - destinationWidth),
      top: clampInt(slice.destinationY, 0, PREPARED_IMAGE_HEIGHT - destinationHeight),
      blend: "over",
    });
  }

  const layer = await sharp({
    create: {
      width: PREPARED_IMAGE_WIDTH,
      height: PREPARED_IMAGE_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(inputs)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgba = layer.data;
  const baseline = Math.min(...slices.map((slice) => slice.destinationY));
  const extent = Math.max(
    1,
    Math.max(...slices.map((slice) => slice.destinationY + slice.destinationHeight)) - baseline,
  );
  for (let y = Math.max(0, Math.floor(baseline)); y < PREPARED_IMAGE_HEIGHT; y += 1) {
    const distance = Math.max(0, (y - baseline) / extent);
    const fade = opacity * Math.exp(-4.2 * distance);
    for (let x = 0; x < PREPARED_IMAGE_WIDTH; x += 1) {
      const alphaIndex = (y * PREPARED_IMAGE_WIDTH + x) * 4 + 3;
      rgba[alphaIndex] = Math.round((rgba[alphaIndex] ?? 0) * fade);
    }
  }

  return sharp(rgba, {
    raw: { width: PREPARED_IMAGE_WIDTH, height: PREPARED_IMAGE_HEIGHT, channels: 4 },
  })
    .blur(2.4)
    .png()
    .toBuffer();
}

export async function composeDefaultProcessedPhoto(input: {
  cutout: Buffer;
  backdrop: Buffer;
  shotType?: string | null;
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

  const profile = buildGroundEffectProfile(analysis);
  const geometry = buildGroundPlaneGeometry(
    raw.info.width,
    raw.info.height,
    analysis,
    PREPARED_IMAGE_WIDTH,
    PREPARED_IMAGE_HEIGHT,
  );
  const footprint = buildAmbientShadowFootprint(geometry, profile, profile.shadow.scale);
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
  const contactScale = Math.max(0.25, (profile.shadow.widthFactor * profile.shadow.scale) / 100);
  const contactMarkup = geometry.contactZones
    .map((zone, index) => {
      const zoneWidth = Math.min(
        geometry.vehicleWidth * 0.34,
        Math.max(
          (zone.right - zone.left) * contactScale * 1.45,
          geometry.vehicleWidth *
            (profile.view === "front" || profile.view === "rear" ? 0.17 : 0.11),
        ),
      );
      const zoneDepth = Math.max(
        7,
        geometry.vehicleHeight *
          (profile.view === "front" || profile.view === "rear" ? 0.034 : 0.026),
      );
      const zoneCenter =
        geometry.contactCenter + (zone.center - geometry.contactCenter) * contactScale;
      return `<ellipse cx="${svgNumber(zoneCenter)}" cy="${svgNumber(zone.groundY)}" rx="${svgNumber(zoneWidth * 0.52)}" ry="${svgNumber(zoneDepth * 0.54)}" fill="url(#contact-${index})"/>`;
    })
    .join("");
  const contactDefs = geometry.contactZones
    .map(
      (zone, index) =>
        `<radialGradient id="contact-${index}"><stop offset="0" stop-color="#090b0d" stop-opacity="${svgNumber((profile.shadow.opacity / 100) * (0.74 + zone.strength * 0.2))}"/><stop offset="0.48" stop-color="#111418" stop-opacity="${svgNumber((profile.shadow.opacity / 100) * 0.42)}"/><stop offset="1" stop-color="#111418" stop-opacity="0"/></radialGradient>`,
    )
    .join("");
  const shadowSvg =
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PREPARED_IMAGE_WIDTH}" height="${PREPARED_IMAGE_HEIGHT}">
    <defs>
      <linearGradient id="ambient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#15181b" stop-opacity="${svgNumber((profile.shadow.opacity / 100) * 0.26)}"/>
        <stop offset="0.38" stop-color="#1d2023" stop-opacity="${svgNumber((profile.shadow.opacity / 100) * 0.15)}"/>
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
      version: "ground-plane-v2",
      contact_zones: geometry.contactZones.length,
      contact_confidence: geometry.contactConfidence,
      reflection_enabled: reflectionSlices.length > 0,
      ambient_depth: ambientDepth,
      projection_direction: geometry.projectionDirection,
    },
  };
}
