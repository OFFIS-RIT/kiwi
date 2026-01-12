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

Prerequisites: Docker + Docker Compose.

1. Copy the sample environment file:

```bash
cp .env.sample .env
```

2. Start the dev environment:

```bash
make dev
```

Useful commands:

```bash
make dev-backend  # backend + worker only
make dev-stop     # stop dev environment
make migrate      # run DB migrations
```

For more details on services/ports, see `README.md`.

## Project Conventions

### Backend (Go)

- Format Go code with `gofmt`.
- **Do not edit generated sqlc files.** Modify the `.sql` query files and regenerate.
- After changing SQL queries, run:

```bash
cd backend && make generate
```

### Frontend (Next.js)

- Use Bun scripts within `frontend/`:

```bash
bun run dev
bun run build
bun run lint
bun run format
```

- Don’t edit `frontend/components/ui/` directly (generated/shadcn).
- Don’t call `fetch()` directly; use the app API client.
- Don’t store server state in `useState`; use TanStack Query.
- If you add components, update barrel exports (`index.ts`).

## Commit Messages

Please use a Conventional Commits-style format:

```
<type>(<scope>): <short summary>
```

Types (common): `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

Scopes (use what you touched): `backend`, `frontend`, `worker`, `migrations`, `infra`, `docs`.

Examples:

- `feat(backend): add graph traversal endpoint`
- `fix(frontend): handle empty chat state`
- `docs(backend): document sqlc regeneration workflow`
- `refactor(worker): simplify job retry logic`

## Pull Requests

We welcome PRs! Before opening a PR:

1. Open or find a related issue first (especially for non-trivial changes).
2. Keep PRs focused and small when possible.
3. Fill out the PR template: `.github/pull_request_template.md`.

### What we look for

- Clear description of the change and motivation.
- Tests updated/added where it makes sense.
- Codegen run when applicable (e.g., `backend && make generate`).
- Formatting applied (Go `gofmt`, frontend `bun run format`).

## Maintainers

Maintained by the KIWI maintainers.
