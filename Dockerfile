# syntax=docker/dockerfile:1

# ONNX Runtime's published Node binaries link against glibc. Keep build and
# runtime on Debian so the production worker does not load those binaries in a
# musl-only Alpine process.
FROM oven/bun:1.2.22 AS build

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .

# These values are intentionally browser-safe and are compiled into Vite's
# client bundle. DigitalOcean passes BUILD_TIME variables as Docker build args.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY}

RUN test -n "$VITE_SUPABASE_URL" \
  && test -n "$VITE_SUPABASE_PUBLISHABLE_KEY" \
  && bun run build

FROM node:22.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DEALERSHOT_V3_CHILD_PATH=.worker-v3/child.mjs
ENV DEALERSHOT_V3_MODEL_DIR=/app/worker-assets/vehicle-segmentation-v3

WORKDIR /app

COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/.worker ./.worker
COPY --from=build --chown=node:node /app/.worker-v3 ./.worker-v3
COPY --from=build --chown=node:node /app/.worker-verify ./.worker-verify
COPY --from=build --chown=node:node /app/worker-assets/vehicle-segmentation-v3 ./worker-assets/vehicle-segmentation-v3
COPY --from=build --chown=node:node /app/scripts/background-removal-runtime-fixture.jpg ./scripts/background-removal-runtime-fixture.jpg
COPY --from=build --chown=node:node /app/scripts/vehicle-segmentation-v3-assets.mjs ./scripts/vehicle-segmentation-v3-assets.mjs
COPY --from=build --chown=node:node /app/scripts/vehicle-segmentation-v3-runtime-fixture.jpg ./scripts/vehicle-segmentation-v3-runtime-fixture.jpg
COPY --from=build --chown=node:node /app/scripts/verify-vehicle-segmentation-v3-worker-runtime.mjs ./scripts/verify-vehicle-segmentation-v3-worker-runtime.mjs
# The worker bundle dynamically loads Sharp's platform-specific native addon.
# The package, its direct JavaScript dependencies, and the matching glibc addon
# and libvips packages must remain available at runtime.
COPY --from=build --chown=node:node /app/node_modules/sharp ./node_modules/sharp
COPY --from=build --chown=node:node /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=build --chown=node:node /app/node_modules/semver ./node_modules/semver
COPY --from=build --chown=node:node /app/node_modules/@img ./node_modules/@img
# Bulk Capture can queue private background removal. The verified model chunks
# live in .output/public and inference loads lazily; only ONNX's native runtime
# must remain available beside the worker bundle.
COPY --from=build --chown=node:node /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=build --chown=node:node /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common

USER node

# Run the inference contract under the same Node/glibc runtime used by the
# deployed worker. The Bun build stage is not a valid proxy for native memory.
# Exercise Sharp itself first so a missing JavaScript package, native addon, or
# libvips runtime fails the image build before the V3 child starts.
RUN node --input-type=module -e "const { default: sharp } = await import('sharp'); const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(); if (png.length < 8 || sharp.versions.sharp !== '0.35.3') throw new Error('Sharp runtime verification failed')"
RUN node .worker-verify/verify.mjs
RUN node scripts/verify-vehicle-segmentation-v3-worker-runtime.mjs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
