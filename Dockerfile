# One image for the API (which also serves the built web app) and the render worker.
FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg espeak-ng ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY workers/renderer/package.json workers/renderer/
COPY packages/shared/package.json packages/shared/
COPY packages/geo/package.json packages/geo/
COPY packages/storyboard/package.json packages/storyboard/
COPY packages/video-engine/package.json packages/video-engine/
COPY packages/server-core/package.json packages/server-core/
RUN pnpm install --frozen-lockfile
COPY . .
# Public-domain map data and OFL fonts are downloaded, not committed.
RUN bash scripts/fetch-assets.sh
RUN pnpm --filter @atlas/web build && pnpm --filter @atlas/api build && pnpm --filter @atlas/renderer-worker build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
RUN useradd --system --uid 10001 atlas && mkdir -p /app/storage && chown -R atlas /app/storage
USER atlas
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]
