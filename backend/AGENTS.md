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
3. Internal packages (`kiwi/...`)

```go
import (
    "context"
    "fmt"

    "github.com/labstack/echo/v4"

    "kiwi/internal/db"
    "kiwi/pkg/ai"
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
logger.Error("Failed to process", "err", err, "queue", queueName)
logger.Fatal("Unable to connect", "err", err)  // exits process
```

## Project Structure

```
cmd/
  server/main.go     # HTTP API entry point (Echo framework)
  worker/main.go     # Background worker (RabbitMQ consumer)

internal/
  db/                # Database layer
    queries/*.sql    # Raw SQL queries for sqlc
    schema.sql       # PostgreSQL schema (with pgvector)
    *.go             # Generated code (sqlc) - DO NOT EDIT
  server/
    routes/          # HTTP route handlers
    middleware/      # Auth and context middleware
    server.go        # Server initialization
    routes.go        # Route registration
  queue/             # RabbitMQ message handlers
  storage/           # S3 client
  util/              # Utilities (env, retry, IDs)

pkg/
  ai/                # AI client interface and implementations
    openai/          # OpenAI implementation
    ollama/          # Ollama implementation
  common/            # Shared data structures (Graph, Entity, Relationship)
  graph/             # Graph creation, processing, deduplication
  loader/            # File loaders (PDF, image, audio, CSV, Excel)
  store/             # Graph storage interface
  query/             # Graph query interface
  logger/            # Logging abstraction
```

## Database (sqlc)

SQL queries live in `internal/db/queries/*.sql`. After modifying, run:

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

Generated code goes to `internal/db/` - never edit these files directly.

**Note:** After running `make generate`, gopls may show stale errors for newly generated
query methods. If you've added a new query and regenerated, the method exists even if
gopls hasn't updated yet. Verify the method exists in the generated code and proceed.

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `github.com/labstack/echo/v4` | HTTP framework |
| `github.com/jackc/pgx/v5` | PostgreSQL driver |
| `github.com/pgvector/pgvector-go` | Vector similarity search |
| `github.com/rabbitmq/amqp091-go` | Message queue |
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

### Accessing Request Context in Echo
```go
func Handler(c echo.Context) error {
    ctx := c.Request().Context()
    user := c.(*middleware.AppContext).User
    conn := c.(*middleware.AppContext).App.DBConn
    // ...
}
```
