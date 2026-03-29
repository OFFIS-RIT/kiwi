# KIWI - Agent Guidelines

**Updated:** 2026-03-24

Knowledge graph platform for document processing and AI-powered Q&A. Go backend
(API + worker), Next.js frontend, PostgreSQL with pgvector, and standalone Auth
service (better-auth with JWT, Admin plugin, LDAP support).

## GitHub Workflow

### Language Requirement

All GitHub contributions **must be written in English** to ensure consistency
and accessibility for all contributors. This includes:

- Issue titles and descriptions
- Pull request titles and descriptions
- Commit messages
- Code comments and documentation

### Pre-Work Checklist

Before starting work on any Issue, always pull the latest `dev` branch:

```bash
git checkout dev
git pull origin dev
git checkout -b <type>/<short-description>
```

Branch naming rules:

- Use format `<type>/<short-description>` (e.g., `feat/add-user-auth`)
- **Do NOT include issue numbers** in branch names (e.g., avoid
  `feat/123-add-auth`)
- Use descriptive kebab-case names

Branch naming examples:

- `feat/add-user-auth`
- `fix/chat-scroll-bug`
- `docs/agents-github-workflow-guidelines`

### Issue & PR Templates

**Creating Issues:**

- Bug reports: Use `.github/ISSUE_TEMPLATE/bug_report.md` - Title prefix:
  `[Bug]: `
- Feature requests: Use `.github/ISSUE_TEMPLATE/feature_request.md` - Title
  prefix: `[Feature]: `
- Always assign to the current GitHub user (use `gh api user --jq '.login'` to
  get username)

**Creating Pull Requests:**

- Always use `.github/pull_request_template.md`
- Fill out all sections: Summary, Type of Change, Changes Made, Related Issues,
  Testing, Checklist
- Always assign to the current GitHub user
- Include ALL checkboxes from templates, even if unchecked (don't remove
  unfilled items)

### GitHub Labels

Always apply appropriate labels when creating Issues and PRs:

| Label            | Usage                      |
| ---------------- | -------------------------- |
| `bug`            | Something isn't working    |
| `enhancement`    | New feature or request     |
| `documentation`  | Documentation improvements |
| `frontend`       | Frontend-related changes   |
| `backend`        | Backend-related changes    |
| `auth`           | Authentication-related     |
| `ci`             | CI/CD changes              |
| `docker`         | Docker/container changes   |
| `dependencies`   | Dependency updates         |
| `github_actions` | GitHub Actions changes     |


### Commit Messages

Use Conventional Commits-style format:

```
<type>(<scope>): <short summary>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`

**Scopes:** `backend`, `frontend`, `worker`, `migrations`, `infra`, `docs`

**Examples:**

- `feat(backend): add graph traversal endpoint`
- `fix(frontend): handle empty chat state`
- `docs(backend): document sqlc regeneration workflow`
- `refactor(worker): simplify job retry logic`

## Quick Start

```bash
# Development
make dev              # Start all services (follows logs)
make dev-backend      # Start without frontend
make dev-stop         # Stop dev environment

# Production
make build            # Build all Docker images
make start            # Start production
make stop             # Stop production

# Database
make migrate          # Run migrations (uses DATABASE_DIRECT_URL when set)

# Backend code generation
cd backend && make generate   # Generate sqlc code after modifying .sql files
```

## First Time Setup

After `make dev`, the `rustfs-setup` container auto-creates the S3 bucket.

## Structure

```
kiwi/
├── backend/           # Go API server + worker (see backend/AGENTS.md)
│   ├── cmd/           # Entry points: server, worker
│   ├── internal/      # Private: db, server, storage, workflow
│   └── pkg/           # Public: ai, graph, loader, store, query, workflow
├── auth/              # Auth service (better-auth, Elysia, Bun)
│   └── src/           # Auth config, permissions, LDAP credentials
├── frontend/          # Next.js SPA (see frontend/AGENTS.md)
│   ├── app/           # Single-page dashboard
│   ├── components/    # Feature-based components (auth/, admin/, etc.)
│   ├── hooks/         # TanStack Query hooks
│   ├── lib/           # API client, auth client, permissions
│   └── providers/     # React Context providers (AuthProvider, etc.)
├── migrations/        # PostgreSQL migrations (golang-migrate)
└── nginx/             # Production reverse proxy config
```

## Where to Look

| Task             | Location                                | Notes                                 |
| ---------------- | --------------------------------------- | ------------------------------------- |
| Add API endpoint | `backend/internal/server/routes/`       | Follow `{verb}_{resource}.go` pattern |
| Add SQL query    | `backend/pkg/db/pgx/queries/`          | Run `make generate` after             |
| Add UI component | `frontend/components/{feature}/`        | Add to barrel exports                 |
| Add data hook    | `frontend/hooks/use-data.ts`            | Use TanStack Query                    |
| Add provider     | `frontend/providers/`                   | Compose in AppProviders               |
| Auth permissions  | `auth/src/permissions.ts`               | Shared roles/AC; copied to frontend   |
| Auth config      | `auth/src/auth.ts`                      | better-auth server config             |
| Auth middleware   | `backend/internal/server/middleware/`    | JWT validation, RBAC                  |
| Database schema  | `migrations/`                           | Use golang-migrate format             |
| AI logic         | `backend/pkg/ai/`, `backend/pkg/graph/` | OpenAI/Ollama implementations         |
| File processing  | `backend/pkg/loader/`                   | PDF, image, audio, CSV, Excel         |
| Durable workflows | `backend/pkg/workflow/`, `backend/pkg/store/` | Replayable workflow runtime + persistence |

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌─────────────┐
│   Frontend   │────▶│    Nginx     │────▶│   Backend   │
│  (Next.js)   │     │   (prod)     │     │   (Echo)    │
└──────────────┘     └──────────────┘     └─────────────┘
       │                                         │
       ▼                                         ▼
┌──────────────┐                          ┌─────────────┐
│     Auth     │                          │  PostgreSQL │
│   (Service)  │                          │  + pgvector │
└──────────────┘                          └─────────────┘
                                                 ▲
                                                 │
                                         ┌──────────────┐
                                         │    Worker    │
                                         │  (workflow)  │
                                         └──────────────┘
                                           │        │
                                           ▼        ▼
                                     ┌──────────┐ ┌──────────────┐
                                     │  RustFS  │ │ Ollama/OpenAI│
                                     │  (S3)    │ │   (AI/LLM)   │
                                     └──────────┘ └──────────────┘
```

## Services (Docker Compose)

| Service    | Dev Port  | Purpose                       |
| ---------- | --------- | ----------------------------- |
| db         | internal  | PostgreSQL + pgvector         |
| db-bouncer | 5432      | PostgreSQL connection pool    |
| rustfs     | 9000, 9001 | S3-compatible storage        |
| ollama     | 11434     | Local LLM inference           |
| server     | 8080      | Go API server                 |
| worker     | -         | Durable workflow worker       |
| frontend   | 3000      | Next.js dev server            |
| auth       | 4321      | Auth (better-auth, JWT + RBAC)|

## Environment Variables

Copy `.env.sample` to `.env`. Key variables:

| Variable                                      | Purpose                                   |
| --------------------------------------------- | ----------------------------------------- |
| `DATABASE_URL`                                | PgBouncer PostgreSQL connection           |
| `DATABASE_DIRECT_URL`                         | Direct PostgreSQL connection for migrations |
| `MASTER_USER_ID`, `MASTER_USER_ROLE`          | Master API user identity for backend auth |
| `MASTER_USER_NAME`, `MASTER_USER_EMAIL`       | Optional bootstrap values for the master user row |
| `AWS_*`                                       | RustFS/S3 config (endpoint, keys, bucket) |
| `AI_ADAPTER`                                  | `openai` or `ollama`                      |
| `AI_CHAT_URL`, `AI_EMBED_URL`, `AI_IMAGE_URL` | AI service endpoints                      |
| `AI_*_MODEL`                                  | Model names for chat/embed/image          |
| `WORKFLOW_WORKER_CONCURRENCY`                 | Parallel workflow runs per worker process |
| `WORKFLOW_MAX_ATTEMPTS`                       | Retry limit for durable workflows         |
| `NEXT_PUBLIC_API_URL`                         | Frontend API base URL                     |
| `NEXT_PUBLIC_AUTH_URL`                        | Frontend auth service base URL            |
| `NEXT_PUBLIC_AUTH_MODE`                       | `credentials` or `ldap`                   |
| `AUTH_SECRET`                                 | Auth service signing secret               |
| `AUTH_URL`                                    | Auth service base URL (internal)          |
| `AUTH_TRUSTED_ORIGINS`                        | Allowed frontend origins (comma-separated)|

## Database Migrations

Migrations in `migrations/` use golang-migrate format:

```bash
make migrate   # Apply pending migrations

# Create new migration manually:
# migrations/{N+1}_{description}.up.sql
# migrations/{N+1}_{description}.down.sql
```

When `MASTER_USER_ID` is configured, the migration runner also bootstraps the
matching row in `users` after applying migrations.

## Subdirectory Guidelines

- **Backend**: See `backend/AGENTS.md` for Go conventions, sqlc, testing
- **Frontend**: See `frontend/AGENTS.md` for React patterns, TanStack Query,
  components

## Pre-Commit Requirements

Before committing any changes, ensure the following steps are performed:

1. **Documentation Check**:

   - Verify and update `AGENTS.md` and `README.md` if the changes affect
     architecture, workflows, or setup.
   - Ensure documentation stays in sync with the code.

2. **Backend Verification**:

   - **Build**: Run `go build ./...` in `backend/` to ensure binary compilation
     succeeds.
   - **Test**: Run `go test ./...` in `backend/` to ensure all tests pass.
   - **Lint**: Follow standard Go conventions (no linter configured).

3. **Frontend Verification**:
   - **Build**: Run `bun run build` in `frontend/` to check for build errors.
   - **Lint**: Run `bun run lint` in `frontend/` to catch code quality issues.
   - **Format**: Run `bun run format:check` in `frontend/` to ensure code style
     compliance.

## Anti-Patterns

| Do NOT                             | Do Instead                               |
| ---------------------------------- | ---------------------------------------- |
| Edit generated sqlc files          | Modify `.sql` files, run `make generate` |
| Add routes without handler pattern | Use `{Method}{Resource}Handler` naming   |
| Use useState for API data          | Use TanStack Query hooks                 |
| Create new Next.js routes          | Add state to NavigationProvider          |
| Skip barrel exports                | Always update `index.ts` files           |

## Common Workflows

### Adding a New Feature (Full Stack)

1. **Database**: Add migration in `migrations/`
2. **Backend Query**: Add to `backend/pkg/db/pgx/queries/`, run `make generate`
3. **Backend Route**: Add handler in `backend/internal/server/routes/`
4. **Frontend API**: Add function in `frontend/lib/api/`
5. **Frontend Hook**: Add to `frontend/hooks/use-data.ts`
6. **Frontend UI**: Add component in `frontend/components/{feature}/`

### Processing Pipeline

1. User uploads files → API stores in RustFS
2. API enqueues durable workflow runs in PostgreSQL
3. Worker claims workflow runs, loads files via `pkg/loader/`
4. Worker extracts entities/relations via `pkg/graph/` + AI
5. Worker stores graph in PostgreSQL with embeddings and schedules follow-up description workflows
6. User queries via chat → vector search + AI response
