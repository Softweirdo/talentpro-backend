# syntax=docker/dockerfile:1

# ── Base ────────────────────────────────────────────────────────────────────
# Debian slim rather than Alpine: argon2 is a native module, and it ships
# prebuilt binaries for glibc. On musl there is no prebuild, so every image
# build would compile it from source with python3/make/g++ installed.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ── Dependencies ────────────────────────────────────────────────────────────
# Split from the build stage so a source-only change does not reinstall.
FROM base AS deps
COPY package.json package-lock.json* ./
# Production tree only — this is what gets copied into the runtime image.
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild argon2 \
 && npm cache clean --force

# ── Build ───────────────────────────────────────────────────────────────────
FROM base AS build
ENV NODE_ENV=development
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts && npm rebuild argon2
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/build-report.mjs ./scripts/build-report.mjs
# Excludes tests, the seed script and sourcemaps.
RUN npm run build:prod

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime

# node:22-slim already provides an unprivileged `node` user (uid 1000).
ENV PORT=4048 \
    NODE_OPTIONS=--enable-source-maps

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./

# CapRover passes the deployed commit as a build arg (it currently warns that
# it is unconsumed). Consuming it here does two jobs. /health can report which
# build is actually live, and — because this layer differs per commit — a fully
# cached rebuild can no longer produce a byte-identical image id, which Swarm
# treats as "nothing changed" and silently declines to roll. Declared last so
# a new commit still reuses the dependency and build layers above.
ARG CAPROVER_GIT_COMMIT_SHA=unknown
ENV GIT_COMMIT_SHA=$CAPROVER_GIT_COMMIT_SHA

USER node
EXPOSE 4048

# The API refuses to start in production without the indexes that enforce
# first-referrer-wins and one-reward-per-referral, so a failing container here
# is a real signal rather than a flake.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4048)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node is PID 1 here. The server installs SIGTERM/SIGINT handlers and closes
# the HTTP server and Mongo connection, so no init shim is needed.
CMD ["node", "dist/server.js"]
