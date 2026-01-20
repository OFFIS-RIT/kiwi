# Build Stage
FROM oven/bun:1 AS builder
WORKDIR /app

# Accept build arguments for Next.js public environment variables
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Production Stage
FROM oven/bun:1 AS runner
WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Install serve globally
RUN bun install -g serve@14.2.5

# Create a non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy the static export output
COPY --from=builder --chown=nextjs:nodejs /app/out ./out

# Switch to non-root user
USER nextjs

EXPOSE 3000

# Use serve to serve the static files
CMD ["serve", "-s", "out", "-l", "3000"]
