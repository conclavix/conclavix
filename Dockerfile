# syntax=docker/dockerfile:1
FROM node:24-trixie-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @conclavix/core --filter @conclavix/api --filter @conclavix/web build \
  && pnpm --filter @conclavix/api deploy --prod --legacy /out \
  && cp -r apps/web/dist /out/public

FROM node:24-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o node -g node -m 0750 /var/lib/conclavix/workspace
ENV NODE_ENV=production
ENV WEB_ROOT=/app/public
ENV WORKSPACE_ROOT=/var/lib/conclavix/workspace
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3300
CMD ["node", "dist/server.js"]
