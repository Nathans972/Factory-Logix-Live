# Builds the React app and serves it with nginx (reverse-proxying /api to the api service).
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @fld/web... --config.confirmModulesPurge=false
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter @fld/shared build && pnpm --filter @fld/engine build && pnpm --filter @fld/web build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
