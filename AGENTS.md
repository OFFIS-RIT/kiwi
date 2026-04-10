# Technologies

- Bun workspaces + Turbo for the monorepo and task running
- Next.js 16 + React 19 for `apps/frontend`
- Elysia for `apps/api`
- AI SDK for model access and streaming
- Drizzle ORM + Drizzle Kit for database access and migrations
- PostgreSQL + pgvector for storage
- OpenWorkflow for background workflows in `apps/worker`
- Better Auth in `packages/auth`

# Commands

- `bun run build`: run the workspace build
- `bun run lint`: run lint checks
- `bun run format`: run formatting
- `bun run db:generate`: generate Drizzle migrations
- `bun run db:generate --custom`: create a custom migration scaffold first when a manual migration is needed
- `bun run db:studio`: open Drizzle Studio

Rules:

- Never run `bun run dev`; always assume a dev server is already running.
- Never run `bun run db:migrate`.
- Never hand-create migration files first; run `bun run db:generate --custom` before editing a custom migration.

# Structure

- `apps/api`: Elysia API entrypoint, routes, auth bridge, OpenWorkflow backend wiring
- `apps/frontend`: Next.js app, UI components, providers, frontend API client
- `apps/worker`: OpenWorkflow worker and workflow implementations
- `packages/ai`: shared AI adapter and model utilities
- `packages/auth`: Better Auth server/client setup and permissions
- `packages/db`: Drizzle schema and database access
- `packages/files`: shared S3/RustFS file helpers
- `packages/graph`: graph extraction and processing logic
- `packages/logger`: logging and OpenTelemetry helpers
- `migrations`: SQL migrations managed by Drizzle Kit
- `postgres`: PostgreSQL and migration container files
- `nginx`: production reverse proxy config
- `compose.yml`: local infrastructure only
- `compose.prod.yml`: production container stack

# Coding Style

- Keep changes minimal and local; prefer the smallest correct change.
- Follow existing workspace patterns instead of introducing new abstractions.
- Use TypeScript throughout; keep types explicit when they improve clarity.
- Prefer shared packages over duplicating logic across apps.
- In frontend code, use existing path aliases and established component/provider patterns.
- Do not edit generated output unless the workflow explicitly requires it.
- Keep comments rare and only add them when the code is not self-evident.
