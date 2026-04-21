FROM oven/bun:1 AS build

WORKDIR /app

# Cache workspace dependency installation
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

COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/worker/workflows apps/worker/workflows
COPY apps/worker/tsconfig.json apps/worker/tsconfig.json
COPY packages/ai/src packages/ai/src
COPY packages/ai/tsconfig.json packages/ai/tsconfig.json
COPY packages/auth/src packages/auth/src
COPY packages/auth/tsconfig.json packages/auth/tsconfig.json
COPY packages/db/src packages/db/src
COPY packages/db/tsconfig.json packages/db/tsconfig.json
COPY packages/files/src packages/files/src
COPY packages/files/tsconfig.json packages/files/tsconfig.json
COPY packages/graph/src packages/graph/src
COPY packages/graph/tsconfig.json packages/graph/tsconfig.json
COPY packages/logger/src packages/logger/src
COPY packages/logger/tsconfig.json packages/logger/tsconfig.json

WORKDIR /app/apps/api

ENV NODE_ENV=production

RUN bun build \
    --compile \
    --minify-whitespace \
    --minify-syntax \
    --outfile server \
    src/index.ts

FROM busybox:1.36.1-uclibc AS busybox

FROM gcr.io/distroless/base

WORKDIR /app

COPY --from=build /app/apps/api/server server
COPY --from=busybox /bin/busybox /busybox

ENV NODE_ENV=production

EXPOSE 4321

CMD ["./server"]
