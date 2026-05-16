FROM oven/bun:1 AS builder
WORKDIR /app

ARG VITE_APP_BUILD_LABEL=
ENV VITE_APP_BUILD_LABEL=${VITE_APP_BUILD_LABEL}

COPY package.json bun.lock ./
COPY patches patches
COPY apps/api/package.json apps/api/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/files/package.json packages/files/package.json
COPY packages/graph/package.json packages/graph/package.json
COPY packages/logger/package.json packages/logger/package.json

RUN bun install --frozen-lockfile

COPY apps/frontend apps/frontend
COPY apps/api/src/types apps/api/src/types
COPY packages/ai/src packages/ai/src
COPY packages/ai/tsconfig.json packages/ai/tsconfig.json
COPY packages/auth/src packages/auth/src
COPY packages/auth/tsconfig.json packages/auth/tsconfig.json

WORKDIR /app/apps/frontend
RUN bun run build

WORKDIR /app
RUN rm -rf node_modules && bun install --production --frozen-lockfile --linker=hoisted

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs --no-create-home appuser

COPY --from=builder --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/apps/frontend/build ./apps/frontend/build
COPY --from=builder --chown=appuser:nodejs /app/apps/frontend/package.json ./apps/frontend/package.json
COPY --from=builder --chown=appuser:nodejs /app/package.json ./package.json

USER appuser
EXPOSE 3000

WORKDIR /app/apps/frontend
CMD ["node", "/app/node_modules/.bin/react-router-serve", "./build/server/index.js"]
