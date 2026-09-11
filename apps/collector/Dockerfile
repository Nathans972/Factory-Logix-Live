# FactoryLogix Live Dashboard - collector service.
# Build from the repository root:  docker build -f apps/collector/Dockerfile .
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- build: install every workspace dependency and compile shared -> engine -> collector ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY apps/collector/package.json apps/collector/package.json
RUN pnpm install --frozen-lockfile --filter @fld/collector... --filter @fld/shared --filter @fld/engine

COPY packages/shared packages/shared
COPY packages/engine packages/engine
COPY apps/collector apps/collector
RUN pnpm --filter @fld/shared build \
 && pnpm --filter @fld/engine build \
 && pnpm --filter @fld/collector build
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter @fld/collector... --filter @fld/shared --filter @fld/engine

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production
ENV LOG_LEVEL=info
COPY --from=build /app /app
USER node
CMD node apps/collector/dist/index.js
