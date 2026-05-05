# Build Stage
FROM oven/bun:1 AS builder
WORKDIR /app

# Accept build arguments for Next.js public environment variables
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_AUTH_URL=/auth
ARG NEXT_PUBLIC_AUTH_MODE=credentials
ARG NEXT_PUBLIC_APP_BUILD_LABEL=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_AUTH_URL=${NEXT_PUBLIC_AUTH_URL}
ENV NEXT_PUBLIC_AUTH_MODE=${NEXT_PUBLIC_AUTH_MODE}
ENV NEXT_PUBLIC_APP_BUILD_LABEL=${NEXT_PUBLIC_APP_BUILD_LABEL}

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
COPY apps/frontend/next.config.ts apps/frontend/next.config.ts
COPY apps/frontend/components.json apps/frontend/components.json
COPY apps/frontend/postcss.config.mjs apps/frontend/postcss.config.mjs
COPY apps/frontend/tsconfig.json apps/frontend/tsconfig.json
COPY apps/api/src/types apps/api/src/types
COPY packages/ai/src packages/ai/src
COPY packages/ai/tsconfig.json packages/ai/tsconfig.json
COPY packages/auth/src packages/auth/src
COPY packages/auth/tsconfig.json packages/auth/tsconfig.json

WORKDIR /app/apps/frontend

RUN bun run build

# Production Stage
FROM oven/bun:1 AS runner
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV BUN_INSTALL=/usr/local
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

# Install serve globally
RUN bun install -g serve@14.2.5

# Create a non-root user for security
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --no-create-home nextjs

# Copy the static export output
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/out ./out

# Switch to non-root user
USER nextjs

EXPOSE 3000

# Use serve to serve the static files
CMD ["serve", "-s", "out", "-l", "3000"]
