# Build Stage
FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
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

COPY apps/frontend/ apps/frontend/
COPY apps/api/src/types apps/api/src/types
COPY packages/ai/src packages/ai/src
COPY packages/ai/tsconfig.json packages/ai/tsconfig.json
COPY packages/auth/src packages/auth/src
COPY packages/auth/tsconfig.json packages/auth/tsconfig.json

WORKDIR /app/apps/frontend
RUN bun run build

# Production Stage
FROM node:22-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/public ./apps/frontend/public

USER nextjs
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["node", "apps/frontend/server.js"]
