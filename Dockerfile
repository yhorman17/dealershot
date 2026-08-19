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

WORKDIR /app

COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/.worker ./.worker
# The worker bundle dynamically loads Sharp's platform-specific native addon.
# Vite can bundle Sharp's JavaScript, but the matching glibc addon and libvips
# packages must remain available at runtime.
COPY --from=build --chown=node:node /app/node_modules/@img ./node_modules/@img
# Bulk Capture can queue private background removal. The verified model chunks
# live in .output/public and inference loads lazily; only ONNX's native runtime
# must remain available beside the worker bundle.
COPY --from=build --chown=node:node /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=build --chown=node:node /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
