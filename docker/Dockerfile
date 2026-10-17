# ==============================================================================
# Stage 1: Build client (React + Vite)
# ==============================================================================
FROM node:20-alpine AS build-client

WORKDIR /build/client

# Copy client dependency manifests
COPY client/package*.json ./
RUN npm ci || npm install

# Copy client source code and build static assets
COPY client/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Build server (Express.js + TypeScript)
# ==============================================================================
FROM node:20-alpine AS build-server

WORKDIR /build/server

# Copy server dependency manifests
COPY server/package*.json ./
RUN npm ci || npm install

# Copy server source code and compile TypeScript
COPY server/ ./
RUN npm run build

# ==============================================================================
# Stage 3: Production runtime
# ==============================================================================
FROM node:20-alpine AS production

# Install curl for container healthcheck
RUN apk add --no-cache curl

ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

# Install server production dependencies
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy compiled server code from build-server stage
COPY --from=build-server /build/server/dist ./dist

# Copy compiled client static files from build-client stage
WORKDIR /app/client
COPY --from=build-client /build/client/dist ./dist

# Return to root app directory
WORKDIR /app

# Ensure proper ownership for non-root node user
RUN chown -R node:node /app
USER node

# Expose server port
EXPOSE 3001

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/api/health || curl -f http://localhost:3001/health || exit 1

# Start the application server (it finds /app/client/dist relative to its own files, not the cwd)
CMD ["node", "server/dist/index.js"]
