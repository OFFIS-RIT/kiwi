# KIWI - Agent Guidelines

**Generated:** 2025-01-07
**Commit:** 367692f
**Branch:** maintenance/128-create-agents-md

Knowledge graph platform for document processing and AI-powered Q&A. Go backend (API + worker), Next.js frontend, PostgreSQL with pgvector.

## GitHub Workflow

### Language Requirement

All GitHub contributions **must be written in English** to ensure consistency and accessibility for all contributors. This includes:

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

Branch naming examples:
- `feat/add-user-auth`
- `fix/chat-scroll-bug`
- `docs/agents-github-workflow-guidelines`

### Issue & PR Templates

**Creating Issues:**
- Bug reports: Use `.github/ISSUE_TEMPLATE/bug_report.md` - Title prefix: `[Bug]: `
- Feature requests: Use `.github/ISSUE_TEMPLATE/feature_request.md` - Title prefix: `[Feature]: `
- Always assign to the current GitHub user (use `gh api user --jq '.login'` to get username)

**Creating Pull Requests:**
- Always use `.github/pull_request_template.md`
- Fill out all sections: Summary, Type of Change, Changes Made, Related Issues, Testing, Checklist
- Always assign to the current GitHub user
- Include ALL checkboxes from templates, even if unchecked (don't remove unfilled items)

### GitHub Labels

Always apply appropriate labels when creating Issues and PRs:

| Label | Usage |
|-------|-------|
| `bug` | Something isn't working |
| `enhancement` | New feature or request |
| `documentation` | Documentation improvements |
| `frontend` | Frontend-related changes |
| `backend` | Backend-related changes |
| `auth` | Authentication-related |
| `ci` | CI/CD changes |
| `docker` | Docker/container changes |
| `dependencies` | Dependency updates |
| `github_actions` | GitHub Actions changes |

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
make migrate          # Run migrations (reads .env for DATABASE_URL)

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
│   ├── internal/      # Private: db, server, queue, storage
│   └── pkg/           # Public: ai, graph, loader, store, query
├── frontend/          # Next.js SPA (see frontend/AGENTS.md)
│   ├── app/           # Single-page dashboard
│   ├── components/    # Feature-based components
│   ├── hooks/         # TanStack Query hooks
│   ├── lib/api/       # API client
│   └── providers/     # React Context providers
├── migrations/        # PostgreSQL migrations (golang-migrate)
└── nginx/             # Production reverse proxy config
```

## Where to Look

| Task | Location | Notes |
|------|----------|-------|
| Add API endpoint | `backend/internal/server/routes/` | Follow `{verb}_{resource}.go` pattern |
| Add SQL query | `backend/internal/db/queries/` | Run `make generate` after |
| Add UI component | `frontend/components/{feature}/` | Add to barrel exports |
| Add data hook | `frontend/hooks/use-data.ts` | Use TanStack Query |
| Add provider | `frontend/providers/` | Compose in AppProviders |
| Database schema | `migrations/` | Use golang-migrate format |
| AI logic | `backend/pkg/ai/`, `backend/pkg/graph/` | OpenAI/Ollama implementations |
| File processing | `backend/pkg/loader/` | PDF, image, audio, CSV, Excel |

## Architecture

```
┌──────────────┐     ┌──────────────┐
│   Frontend   │────▶│    Nginx     │────▶ Backend (Echo)
│  (Next.js)   │     │   (prod)     │           │
└──────────────┘     └──────────────┘           │
                                                ▼
┌──────────────┐     ┌──────────────┐     ┌─────────────┐
│   RabbitMQ   │◀───▶│    Worker    │────▶│  PostgreSQL │
│   (queue)    │     │ (background) │     │  + pgvector │
└──────────────┘     └──────────────┘     └─────────────┘
       │                    │
       ▼                    ▼
┌──────────────┐     ┌──────────────┐
│    RustFS    │     │ Ollama/OpenAI│
│  (S3 files)  │     │   (AI/LLM)   │
└──────────────┘     └──────────────┘
```

## Services (Docker Compose)

| Service | Dev Port | Purpose |
|---------|----------|---------|
| db | 5432 | PostgreSQL + pgvector |
| rabbitmq | 5672, 15672 | Message queue + management UI |
| rustfs | 9000, 9001 | S3-compatible storage |
| ollama | 11434 | Local LLM inference |
| server | 8080 | Go API server |
| worker | - | Background job processor |
| frontend | 3000 | Next.js dev server |
| auth | 4321 | Auth |

## Environment Variables

Copy `.env.sample` to `.env`. Key variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection |
| `AWS_*` | RustFS/S3 config (endpoint, keys, bucket) |
| `AI_ADAPTER` | `openai` or `ollama` |
| `AI_CHAT_URL`, `AI_EMBED_URL`, `AI_IMAGE_URL` | AI service endpoints |
| `AI_*_MODEL` | Model names for chat/embed/image |
| `RABBITMQ_*` | Queue connection |
| `NEXT_PUBLIC_API_URL` | Frontend API base URL |

## Database Migrations

Migrations in `migrations/` use golang-migrate format:

```bash
make migrate   # Apply pending migrations

# Create new migration manually:
# migrations/{N+1}_{description}.up.sql
# migrations/{N+1}_{description}.down.sql
```

## Subdirectory Guidelines

- **Backend**: See `backend/AGENTS.md` for Go conventions, sqlc, testing
- **Frontend**: See `frontend/AGENTS.md` for React patterns, TanStack Query, components

## Pre-Commit Requirements

Before committing any changes, ensure the following steps are performed:

1. **Documentation Check**:
   - Verify and update `AGENTS.md` and `README.md` if the changes affect architecture, workflows, or setup.
   - Ensure documentation stays in sync with the code.

2. **Backend Verification**:
   - **Build**: Run `go build ./...` in `backend/` to ensure binary compilation succeeds.
   - **Test**: Run `go test ./...` in `backend/` to ensure all tests pass.
   - **Lint**: Follow standard Go conventions (no linter configured).

3. **Frontend Verification**:
   - **Build**: Run `bun run build` in `frontend/` to check for build errors.
   - **Lint**: Run `bun run lint` in `frontend/` to catch code quality issues.
   - **Format**: Run `bun run format:check` in `frontend/` to ensure code style compliance.

## Anti-Patterns

| Do NOT | Do Instead |
|--------|------------|
| Edit generated sqlc files | Modify `.sql` files, run `make generate` |
| Add routes without handler pattern | Use `{Method}{Resource}Handler` naming |
| Use useState for API data | Use TanStack Query hooks |
| Create new Next.js routes | Add state to NavigationProvider |
| Skip barrel exports | Always update `index.ts` files |

## Common Workflows

### Adding a New Feature (Full Stack)

1. **Database**: Add migration in `migrations/`
2. **Backend Query**: Add to `backend/internal/db/queries/`, run `make generate`
3. **Backend Route**: Add handler in `backend/internal/server/routes/`
4. **Frontend API**: Add function in `frontend/lib/api/`
5. **Frontend Hook**: Add to `frontend/hooks/use-data.ts`
6. **Frontend UI**: Add component in `frontend/components/{feature}/`

### Processing Pipeline

1. User uploads files → API stores in RustFS
2. API publishes job to RabbitMQ
3. Worker consumes job, loads files via `pkg/loader/`
4. Worker extracts entities/relations via `pkg/graph/` + AI
5. Worker stores graph in PostgreSQL with embeddings
6. User queries via chat → vector search + AI response
