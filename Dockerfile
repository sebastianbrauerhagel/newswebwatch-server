# syntax=docker/dockerfile:1

# ---- Build stage: compile native deps (better-sqlite3 needs python3 + a toolchain) ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Toolchain for building better-sqlite3 from source.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install production deps against a clean lockfile so the native module is built
# for this image's glibc/node — copied as-is into the runtime stage below.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime stage: slim image, no compiler ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Bring in the already-built node_modules and the app source.
COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server

# SQLite lives on a mounted volume; create the mount point and hand it to the
# unprivileged `node` user that the base image ships with.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/newsweb.db

EXPOSE 3000

# Liveness via the app's own endpoint (Node has fetch built in on v20).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
