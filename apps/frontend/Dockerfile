FROM oven/bun:1 AS builder
WORKDIR /app

ARG BUILD_LABEL=
ENV BUILD_LABEL=${BUILD_LABEL}

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

COPY apps/frontend/app apps/frontend/app
COPY apps/frontend/components apps/frontend/components
COPY apps/frontend/hooks apps/frontend/hooks
COPY apps/frontend/lib apps/frontend/lib
COPY apps/frontend/providers apps/frontend/providers
COPY apps/frontend/public apps/frontend/public
COPY apps/frontend/types apps/frontend/types
COPY apps/frontend/i18n apps/frontend/i18n
COPY apps/frontend/messages apps/frontend/messages
COPY apps/frontend/next.config.ts apps/frontend/next.config.ts
COPY apps/frontend/components.json apps/frontend/components.json
COPY apps/frontend/postcss.config.mjs apps/frontend/postcss.config.mjs
COPY apps/frontend/tsconfig.json apps/frontend/tsconfig.json
COPY apps/api/src/types apps/api/src/types
COPY packages/ai/src packages/ai/src
COPY packages/ai/tsconfig.json packages/ai/tsconfig.json
COPY packages/auth/src packages/auth/src
COPY packages/auth/tsconfig.json packages/auth/tsconfig.json
COPY packages/db/src packages/db/src
COPY packages/db/tsconfig.json packages/db/tsconfig.json
COPY packages/logger/src packages/logger/src
COPY packages/logger/tsconfig.json packages/logger/tsconfig.json
COPY packages/files/src/project-file-proxy-path.ts packages/files/src/project-file-proxy-path.ts

WORKDIR /app/apps/frontend
RUN bun run build

FROM node:20-alpine AS runner
WORKDIR /app

ARG BUILD_LABEL=
ENV BUILD_LABEL=${BUILD_LABEL}
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/public ./apps/frontend/public

RUN npm install --omit=dev sharp@0.34.5

USER nextjs
EXPOSE 3000

CMD ["node", "apps/frontend/server.js"]
