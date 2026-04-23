FROM oven/bun:1

WORKDIR /app

RUN bun add --exact drizzle-kit@1.0.0-beta.21 drizzle-orm@1.0.0-beta.21 pg@8.20.0 ulid@3.0.2

COPY drizzle.config.ts ./
COPY migrations migrations
COPY packages/db/src/tables packages/db/src/tables

CMD ["bun", "node_modules/.bin/drizzle-kit", "migrate"]
