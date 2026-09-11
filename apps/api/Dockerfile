# FactoryLogix Live Dashboard — API image.
# Build from the repository root (docker-compose.yml already does this):
#   docker build -f apps/api/Dockerfile -t fld-api .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# build: install workspace deps, compile shared -> engine -> api
# ---------------------------------------------------------------------------
FROM base AS build

# Non-interactive pnpm (it otherwise refuses to purge node_modules without a TTY).
ENV CI=true

# argon2 normally resolves a linux-musl-x64 prebuild; keep a toolchain around in case
# node-gyp has to compile it from source.
RUN apk add --no-cache python3 make g++

# Manifests first so the dependency layer is cached. Every workspace package.json has to be
# present or --frozen-lockfile will not match pnpm-lock.yaml.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/engine/package.json ./packages/engine/
COPY apps/api/package.json ./apps/api/
COPY apps/collector/package.json ./apps/collector/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile --filter @fld/api...

# Sources only (never the host's node_modules).
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY packages/engine/tsconfig.json ./packages/engine/
COPY packages/engine/src ./packages/engine/src
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src

RUN pnpm --filter @fld/shared build \
 && pnpm --filter @fld/engine build \
 && pnpm --filter @fld/api build

# Drop dev dependencies from the store/links.
RUN pnpm install --prod --frozen-lockfile --filter @fld/api...

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3001
# Dual-stack bind. busybox wget (used by the compose healthcheck) resolves "localhost" to ::1
# first, which a plain 0.0.0.0 bind would refuse. "::" accepts both IPv4 and IPv6.
ENV HOST=::
ENV MIGRATIONS_DIR=/app/db/migrations
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/packages/engine/node_modules ./packages/engine/node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules

# Migrations are applied by the API on start.
COPY db/migrations ./db/migrations

EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=10 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1
USER node
CMD ["node", "apps/api/dist/index.js"]
