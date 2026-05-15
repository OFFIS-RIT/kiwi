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

FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --no-create-home appuser

COPY --from=builder --chown=appuser:nodejs /app/apps/frontend/build ./build
COPY --from=builder --chown=appuser:nodejs /app/apps/frontend/package.json ./package.json
COPY --from=builder --chown=appuser:nodejs /app/node_modules ./node_modules

USER appuser
EXPOSE 3000

CMD ["bun", "run", "start"]
