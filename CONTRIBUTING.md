# Contributing to KIWI

Thanks for taking the time to contribute! This project is maintained by the KIWI maintainers.

## Code of Conduct

Please read and follow our Code of Conduct: `CODE_OF_CONDUCT.md`.

## Getting Help / Asking Questions

If you have questions, please open a GitHub Issue describing what you’re trying to do and where you’re stuck.

## Reporting Bugs

- Use the **Bug Report** issue template: `.github/ISSUE_TEMPLATE/bug_report.md`.
- Include clear reproduction steps, expected vs. actual behavior, and environment details.

## Requesting Features

- Use the **Feature Request** template: `.github/ISSUE_TEMPLATE/feature_request.md`.
- Describe the problem, the proposed solution, and alternatives considered.

## Security Issues

We currently handle security reports in the open.

- Please open a GitHub Issue and clearly label it as a security concern.
- If you’re not comfortable sharing details publicly, please hold off on reporting until we add a private reporting channel.

## Development Setup

Prerequisites: [Docker & Docker Compose](https://docs.docker.com/get-docker/) and [Bun](https://bun.sh/).

1. Copy the sample environment file:

```bash
cp .env.sample .env
```

2. Start the local infrastructure (PostgreSQL, RustFS, etc.):

```bash
docker compose up -d
```

3. Start frontend, API, and worker:

```bash
bun run dev
```

The application will be available at:

- **Frontend**: http://localhost:5173
- **API**: http://localhost:4321

For more details on services, ports, and configuration, see `README.md`.

## Project Structure

KIWI is a Bun workspace monorepo orchestrated with Turbo:

- `apps/frontend` — React Router v7 + Vite (SSR) + React 19
- `apps/api` — Elysia API server
- `apps/worker` — OpenWorkflow background worker
- `packages/ai` — Shared AI adapters and model utilities
- `packages/auth` — Better Auth server and client setup
- `packages/db` — Drizzle schema and database access
- `packages/files` — Shared S3/RustFS helpers
- `packages/graph` — Graph extraction and processing
- `packages/logger` — Logging and OpenTelemetry helpers
- `migrations` — SQL migrations managed by Drizzle Kit

## Project Conventions

### Workspace-wide

- TypeScript everywhere; keep types explicit when they improve clarity.
- Prefer shared packages (`packages/*`) over duplicating logic across apps.
- Use `better-result` for async error handling where appropriate.
- Keep changes minimal and local; follow existing patterns rather than introducing new abstractions.

Common scripts (run from the repo root):

```bash
bun run build           # workspace build via Turbo
bun run lint            # lint checks (oxlint)
bun run format          # formatter (oxfmt)
bun run db:generate     # generate Drizzle migrations
bun run db:studio       # open Drizzle Studio
```

### Backend (Elysia + Drizzle)

- Routes live in `apps/api`; OpenWorkflow wiring sits alongside.
- Database schema and queries are in `packages/db` (Drizzle).
- Never hand-create migration files. Run `bun run db:generate` (or `bun run db:generate --custom` for manual migrations) and edit the generated file.

### Frontend (React Router v7 + Vite SSR)

- Routes live in `apps/frontend/app/routes/` (file-based routing).
- Don’t edit `apps/frontend/components/ui/` directly — these are shadcn-generated. Re-run `bunx shadcn add <component>` to update.
- Don’t call `fetch()` directly; use the app API client in `apps/frontend/lib/api/`.
- Don’t store server state in `useState`; use TanStack Query.
- Runtime config (API URL, auth mode, etc.) is loaded via the `root.tsx` loader — don’t bake server values into the bundle.

### Worker (OpenWorkflow)

- Workflow implementations live in `apps/worker`.
- Background work that needs durability/retries belongs here, not in API request handlers.

## Commit Messages

Please use a Conventional Commits-style format:

```
<type>(<scope>): <short summary>
```

Types (common): `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

Scopes (use what you touched): `frontend`, `api`, `worker`, `ai`, `auth`, `db`, `files`, `graph`, `logger`, `migrations`, `infra`, `docs`.

Examples:

- `feat(api): add graph traversal endpoint`
- `fix(frontend): handle empty chat state`
- `refactor(worker): simplify job retry logic`
- `docs(db): document custom migration workflow`

## Pull Requests

We welcome PRs! Before opening a PR:

1. Open or find a related issue first (especially for non-trivial changes).
2. Keep PRs focused and small when possible.
3. Fill out the PR template: `.github/pull_request_template.md`.

### What we look for

- Clear description of the change and motivation.
- Tests updated/added where it makes sense.
- Migrations generated via `bun run db:generate` when schema changes.
- Formatting and lint clean (`bun run format`, `bun run lint`).
- Build green (`bun run build`).

## Maintainers

Maintained by the KIWI maintainers.
