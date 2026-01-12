FROM oven/bun:1-alpine AS build

WORKDIR /app

# Cache packages installation
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY ./src ./src

ENV NODE_ENV=production

RUN bun build \
    --compile \
    --minify-whitespace \
    --minify-syntax \
    --outfile server \
    src/index.ts

FROM gcr.io/distroless/base

WORKDIR /app

COPY --from=build /app/server server

ENV NODE_ENV=production

EXPOSE 4321

CMD ["./server"]
