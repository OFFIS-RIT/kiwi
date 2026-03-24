# Kiwi Backend - Agent Guidelines

Go-based knowledge graph backend that processes documents and extracts entities/relationships using AI. Consists of two binaries: HTTP API server and background worker.

## Build Commands

```bash
# Build binaries
go build ./cmd/server
go build ./cmd/worker

# Build for compile
go build ./...

# Generate Go code from SQL (run after modifying .sql files)
make generate
```

## Testing

```bash
# Run all tests
go test ./...

# Run tests in a specific package
go test ./pkg/graph/...
go test ./internal/util/...

# Run a single test by name
go test -v -run TestSplitIntoSentences ./pkg/graph/...

# Run tests with coverage
go test -cover ./...

# Run tests matching a pattern
go test -v -run "TestRetry.*" ./internal/util/...
```

### Test Conventions
- Test files: `*_test.go`, co-located with source files
- Use table-driven tests (standard Go pattern)
- Use standard `testing` package (no external test frameworks)
- Mock implementations defined inline in test files
- Test function names: `TestFunctionName_Scenario`

## Code Style

### Imports
Group imports in this order, separated by blank lines:
1. Standard library
2. External dependencies
3. Internal packages (`github.com/OFFIS-RIT/kiwi/backend/...`)

```go
import (
    "context"
    "fmt"

	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)
```

### Formatting
- Use `gofmt` (standard Go formatting)
- No linter configuration exists; follow Go conventions

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Route handlers | `{Method}{Resource}Handler` | `GetProjectsHandler`, `CreateGroupHandler` |
| Route files | `{verb}_{resource}.go` | `get_projects.go`, `post_groups.go` |
| SQL query files | `{resource}.sql` | `projects.sql`, `entities.sql` |
| SQL query names | `-- name: {Action}{Resource} :{one\|many\|exec}` | `-- name: GetProjects :many` |
| Interfaces | Descriptive with purpose | `GraphAIClient`, `GraphStorage` |
| Params structs | `{Action}{Resource}Params` | `NewGraphOpenAIClientParams` |
| Response structs | `{action}{Resource}Response` (local) | `getProjectEventsResponse` |

### Types and Interfaces
- Define interfaces in `pkg/` for public APIs
- Implementations go in subdirectories (e.g., `pkg/ai/openai/`, `pkg/ai/ollama/`)
- Use functional options for configurable APIs:

```go
type GenerateOption func(*GenerateOptions)

func WithModel(model string) GenerateOption {
    return func(o *GenerateOptions) { o.Model = model }
}
```

### Error Handling
- Return errors up the call stack; don't panic
- Use `errors.Is()` for context error checking:

```go
if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
    return zero, err
}
```

- In HTTP handlers, return appropriate status codes with JSON error responses:

```go
return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request params"})
```

### Context Propagation
- Always pass `context.Context` as the first parameter
- Respect context cancellation in loops and long operations
- Use `c.Request().Context()` in Echo handlers

### Logging
- Use structured logging with key-value pairs via `kiwi/pkg/logger`:

```go
logger.Info("Starting server", "port", port)
logger.Error("Failed to process workflow", "err", err, "workflow", workflowName)
logger.Fatal("Unable to connect", "err", err)  // exits process
```

## Project Structure

```
cmd/
  server/main.go     # HTTP API entry point (Echo framework)
  worker/main.go     # Background durable workflow worker

internal/
  server/
    routes/          # HTTP route handlers
    middleware/      # Auth and context middleware
    server.go        # Server initialization
    routes.go        # Route registration
  workflow/          # Workflow definitions, enqueueing, worker bootstrap
  storage/           # S3 client
  util/              # Utilities (env, retry, IDs)

pkg/
  ai/                # AI client interface and implementations
    openai/          # OpenAI implementation
    ollama/          # Ollama implementation
  common/            # Shared data structures (Graph, Entity, Relationship)
  db/                # Database adapters
    pgx/             # PostgreSQL adapter (schema.sql, queries/, sqlc output)
  graph/             # Graph creation, processing, deduplication
  loader/            # File loaders (PDF, image, audio, CSV, Excel)
  store/             # Graph storage interface
  query/             # Graph query interface
  workflow/          # Durable workflow engine and worker runtime
  logger/            # Logging abstraction
```

## Workflow Runtime

- Workflow runs are persisted in PostgreSQL via `pkg/store/pgx` and executed by `pkg/workflow`.
- API handlers enqueue `process` and `delete` runs through `internal/workflow.Service`, usually inside the same transaction as project/file changes.
- `cmd/worker` polls pending runs from the database, claims a lease, heartbeats while running, and retries failures with exponential backoff.
- `process` workflows execute `preprocess -> metadata -> chunk -> extract -> dedupe -> save`, then enqueue `description` workflows once all files in a correlation are done.
- `delete` workflows remove file graph data, refresh affected descriptions, and restore the project to `ready` when the batch completes.
- Key env vars: `WORKFLOW_WORKER_CONCURRENCY`, `WORKFLOW_MAX_ATTEMPTS`.

## Database (sqlc)

SQL queries live in `pkg/db/pgx/queries/*.sql`. After modifying, run:

```bash
make generate
```

Query naming format:
```sql
-- name: GetProjectsForUser :many
SELECT ... FROM projects WHERE user_id = $1;

-- name: CreateProject :one
INSERT INTO projects (...) VALUES (...) RETURNING *;

-- name: DeleteProject :exec
DELETE FROM projects WHERE id = $1;
```

Generated code goes to `pkg/db/pgx/` - never edit these files directly.

**Note:** After running `make generate`, gopls may show stale errors for newly generated
query methods. If you've added a new query and regenerated, the method exists even if
gopls hasn't updated yet. Verify the method exists in the generated code and proceed.

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `github.com/labstack/echo/v4` | HTTP framework |
| `github.com/golang-jwt/jwt/v5` | JWT parsing and validation |
| `github.com/MicahParks/keyfunc/v3` | JWKS key resolution for JWT verification |
| `github.com/jackc/pgx/v5` | PostgreSQL driver |
| `github.com/pgvector/pgvector-go` | Vector similarity search |
| `github.com/openai/openai-go/v3` | OpenAI client |
| `github.com/ollama/ollama` | Ollama client |
| `golang.org/x/sync/errgroup` | Parallel processing with error handling |

## Common Patterns

### Parallel Processing with errgroup
```go
g, ctx := errgroup.WithContext(ctx)
for _, item := range items {
    g.Go(func() error {
        return processItem(ctx, item)
    })
}
if err := g.Wait(); err != nil {
    return err
}
```

### Retry Logic
Use utilities from `internal/util/retry.go`:
```go
result, err := util.RetryWithContext(ctx, 3, func(ctx context.Context) (T, error) {
    return doSomething(ctx)
})
```

### Auth Middleware & Permissions

The `internal/server/middleware/` package handles authentication and RBAC:

- `AuthMiddleware` validates JWT tokens (via JWKS from auth service) or master API key
- `AppContext.User` provides `UserID`, `Role`, and `Permissions` to handlers
- Use `RequirePermission("resource.action")` middleware on routes
- Helper functions: `HasPermission()`, `HasAnyPermission()`, `IsAdmin()`

```go
// Route with permission check
apiRoutes.POST("/projects", routes.CreateProjectHandler, middleware.RequirePermission("project.create"))

// Check permissions in handler
if middleware.HasPermission(ctx.User, "group.update") { ... }
```

### Accessing Request Context in Echo
```go
func Handler(c echo.Context) error {
    ctx := c.Request().Context()
    user := c.(*middleware.AppContext).User
    conn := c.(*middleware.AppContext).App.DBConn
    // ...
}
```
