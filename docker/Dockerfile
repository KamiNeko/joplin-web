# syntax=docker/dockerfile:1

# Base image for the target-platform stages, pinned by digest for reproducible builds (Dependabot bumps the digest; keep build-client on the same one).
# Keep the Node.js major in sync with .nvmrc, which CI reads.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS base

# ==============================================================================
# Stage 1: Build client (React + Vite)
# ==============================================================================
# The bundle is plain JS/CSS, so build it natively on the build machine instead of under QEMU
# for every target platform (arm64 `npm ci` crashed or hung under emulation).
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build-client

WORKDIR /build/client

# Playwright is only used for README screenshots; never download browsers here
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY client/ ./
# Build metadata, baked into the bundle through Vite's define (see client/vite.config.ts).
# Declared late so a new commit doesn't invalidate the cached `npm ci` layer.
ARG APP_VERSION=dev
ARG GIT_SHA=
RUN npm run build

# ==============================================================================
# Stage 2: Build server (Express + TypeScript)
# ==============================================================================
FROM base AS build-server

WORKDIR /build/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY server/ ./
RUN npm run build

# ==============================================================================
# Stage 3: Server production dependencies only
# ==============================================================================
FROM base AS server-deps

WORKDIR /build/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ==============================================================================
# Stage 4: Production runtime
# ==============================================================================
FROM base AS production

# The container only needs `node`: drop the package managers that ship with the base image.
# This hides them from the final filesystem (and vulnerability scanners); it doesn't shrink the base layer.
RUN rm -rf /usr/local/lib/node_modules \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

# App files stay owned by root and are read-only for the runtime user; the app writes nothing to disk.
WORKDIR /app/server
COPY server/package.json ./
COPY --from=server-deps /build/server/node_modules ./node_modules
COPY --from=build-server /build/server/dist ./dist
COPY --from=build-client /build/client/dist /app/client/dist

# Build metadata: reported by GET /api/health and the image labels (same values as the client bundle)
ARG APP_VERSION=dev
ARG GIT_SHA=
ENV NODE_ENV=production \
    PORT=3001 \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA}

# The release workflow sets these too, through docker/metadata-action
LABEL org.opencontainers.image.title="Joplin Web" \
      org.opencontainers.image.description="Web client for self-hosted Joplin Server" \
      org.opencontainers.image.source="https://github.com/KamiNeko/joplin-web" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"

WORKDIR /app
USER node

# Container port. Choose the host port with the -p mapping (HOST_PORT in docker-compose.yml).
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# The server finds /app/client/dist relative to its own files, not the cwd
CMD ["node", "server/dist/index.js"]
