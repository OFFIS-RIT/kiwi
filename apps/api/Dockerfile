FROM oven/bun AS build

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

FROM busybox:1.36.1-uclibc AS busybox

FROM gcr.io/distroless/base

WORKDIR /app

COPY --from=build /app/server server
COPY --from=busybox /bin/busybox /busybox

ENV NODE_ENV=production

EXPOSE 4321

CMD ["./server"]
