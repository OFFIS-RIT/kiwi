FROM oven/bun:1

WORKDIR /app

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

COPY apps/worker/index.ts apps/worker/index.ts
COPY apps/worker/env.ts apps/worker/env.ts
COPY apps/worker/worker.ts apps/worker/worker.ts
COPY apps/worker/openworkflow.config.ts apps/worker/openworkflow.config.ts
COPY apps/worker/tsconfig.json apps/worker/tsconfig.json
COPY apps/worker/lib apps/worker/lib
COPY apps/worker/workflows apps/worker/workflows
COPY packages/ai/src packages/ai/src
COPY packages/ai/tsconfig.json packages/ai/tsconfig.json
COPY packages/db/src packages/db/src
COPY packages/db/tsconfig.json packages/db/tsconfig.json
COPY packages/files/src packages/files/src
COPY packages/files/tsconfig.json packages/files/tsconfig.json
COPY packages/graph/src packages/graph/src
COPY packages/graph/tsconfig.json packages/graph/tsconfig.json
COPY packages/logger/src packages/logger/src
COPY packages/logger/tsconfig.json packages/logger/tsconfig.json

WORKDIR /app/apps/worker

CMD ["bun", "worker.ts"]
