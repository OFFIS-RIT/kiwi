<p align="center">
  <img src="frontend/app/KIWI.jpg" alt="KIWI Logo" width="200" />
</p>

<h1 align="center">KIWI</h1>

<p align="center">
  <strong>Knowledge Graph Platform for Document Processing and AI-powered Q&A created by <a href="https://www.offis.de/">OFFIS e.V.</a></strong>
</p>

<p align="center">
  <img alt="Go" src="https://img.shields.io/badge/go-1.25-00ADD8?style=flat-square&logo=go" />
  <img alt="Next.js" src="https://img.shields.io/badge/next.js-16-black?style=flat-square&logo=next.js" />
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#library-usage">Library Usage</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#agentsmd">Documentation</a>
</p>

---

## Features

- **Document Processing** – Upload PDFs, images, audio, CSV, and Excel files
- **Adaptive PDF OCR Rendering** – Automatically switches to high-resolution tiled rendering with optional panel splitting for large technical drawings (A1/A0)
- **Knowledge Graph Extraction** – AI-powered entity and relationship extraction
- **Graph Storage** – Entities and relations stored as queryable knowledge graph
- **Vector Search** – Semantic search using pgvector embeddings
- **Graph Exploration Tools** – AI-powered tools for relationship traversal,
  multi-hop path finding, and autonomous knowledge exploration
- **Chat Interface** – Ask questions about your documents with streaming AI
  responses (normal and agentic modes)
- **Multi-Model Support** – Works with OpenAI API or local Ollama models
  - **Note:** When using OpenAI API with reasoning enabled, temperature is fixed
    to 1.0 (required by o-series and gpt-5+ models)

## Tech Stack

| Layer    | Technology                                              |
| -------- | ------------------------------------------------------- |
| Frontend | Next.js 16, React 19, TanStack Query, Tailwind CSS, Bun |
| Backend  | Go 1.25, Echo Framework, sqlc                           |
| Database | PostgreSQL + pgvector                                   |
| Workflow | PostgreSQL-backed durable workflow runtime              |
| Storage  | RustFS (S3-compatible)                                  |
| AI       | OpenAI API / Ollama                                     |

---

## Quick Start

### Prerequisites

- [Docker & Docker Compose](https://docs.docker.com/get-docker/)

### Installation

```bash
# Clone the repository
git clone https://github.com/OFFIS-RIT/kiwi.git
cd kiwi

# Configure environment
cp .env.sample .env
# Edit .env with your AI API keys

# Start development environment
make dev
```

The application will be available at:

- **Frontend**: http://localhost:3000
- **API**: http://localhost:8080

Database migrations are now applied automatically on startup by the
`db-migration` container (it runs after `db` is healthy and before backend/auth
services start).

### First Time Setup

The `rustfs-setup` container automatically creates the S3 bucket on first start.

For local AI with Ollama:

```bash
docker exec -it ollama ollama pull <model-name>
```

---

## Development

```bash
make dev              # Start all services (with logs)
make dev-backend      # Start without frontend
make dev-stop         # Stop environment
make migrate          # Run database migrations manually
```

When `MASTER_USER_ID` is configured, `make migrate` and the Compose migration
container also bootstrap the matching row in `users`.

### Services

| Service    | Port     | Description                      |
| ---------- | -------- | -------------------------------- |
| frontend   | 3000     | Next.js dev server               |
| auth       | 4321     | Auth                             |
| server     | 8080     | Go API server                    |
| worker     | -        | Durable workflow worker          |
| db         | internal | PostgreSQL + pgvector            |
| db-bouncer | 5432     | PostgreSQL connection pool       |
| rustfs     | 9000, 9001 | S3-compatible storage          |
| ollama     | 11434    | Local LLM inference              |

### Worker Runtime

The background worker (`backend/cmd/worker`) executes durable workflow runs stored in PostgreSQL.

- API requests enqueue `process`, `delete`, and `description` workflow runs transactionally.
- The worker polls pending runs, claims a lease, heartbeats while executing, and retries failures with backoff.
- File indexing fans out to one `process` workflow per file; once all file workflows in a correlation finish, description workflows are enqueued automatically.
- Delete operations use `delete` workflows and refresh affected descriptions before the project returns to `ready`.

Useful environment variables:

- `WORKFLOW_WORKER_CONCURRENCY`: number of workflow runs a worker process executes in parallel
- `WORKFLOW_MAX_ATTEMPTS`: maximum retry attempts for `process`, `delete`, and `description` workflows

```bash
# From ./backend

# Start a worker
go run ./cmd/worker

# Increase worker parallelism
WORKFLOW_WORKER_CONCURRENCY=4 go run ./cmd/worker
```

---

## Production

```bash
make build    # Build Docker images
make start    # Start production
make stop     # Stop production
```

`make start` also runs the `db-migration` startup container automatically,
which applies pending migrations before app services connect to the database.

### SSL/TLS

Place certificates in `./certs/` – they are mounted to `/etc/nginx/certs/` in
the Nginx container.

---

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
                                     │ (S3)     │ │   (AI/LLM)   │
                                     └──────────┘ └──────────────┘
```

### Processing Pipeline

1. User uploads files → API stores the originals in RustFS
2. API enqueues durable workflow runs in PostgreSQL within the request transaction
3. Worker claims pending runs from workflow storage and processes files (PDF, images, audio, CSV, Excel)
4. Worker extracts entities/relations via AI and stores graph data in PostgreSQL with embeddings
5. When all file workflows in a batch finish, description workflows are enqueued and the project returns to `ready`
6. User queries via chat → vector search, graph traversal, or agentic tool exploration + AI response

### Query Modes

| Mode     | API              | Description                                                              |
| -------- | ---------------- | ------------------------------------------------------------------------ |
| Normal   | `mode=normal`    | Vector similarity search with path finding between relevant entities     |
| Agentic  | `mode=agentic`   | Agentic exploration using graph tools for autonomous knowledge discovery |

#### Graph Exploration Tools (Agentic Mode)

| Tool                           | Capability                                                          |
| ------------------------------ | ------------------------------------------------------------------- |
| `search_entities`              | Semantic vector search to find entities matching a query            |
| `search_entities_by_type`      | Search entities filtered by type (e.g., Person, Organization)       |
| `get_entity_types`             | List all entity types with counts                                   |
| `get_entity_neighbours`        | Relationship traversal: get directly connected entities             |
| `get_entity_details`           | Retrieve full entity descriptions by ID                             |
| `path_between_entities`        | Multi-hop traversal: find shortest path between entities (Dijkstra) |
| `get_entity_sources`           | Retrieve source text chunks for entities (citations)                |
| `get_relationship_sources`     | Retrieve source text chunks for relationships                       |
| `get_source_document_metadata` | Get document metadata for source context                            |

---

## Library Usage

KIWI can be used as a standalone platform or as a Go library with pluggable
adapters. Implement these interfaces to integrate with your own infrastructure:

| Interface          | Package      | Purpose                                                            |
| ------------------ | ------------ | ------------------------------------------------------------------ |
| `GraphAIClient`    | `pkg/ai`     | AI operations (completions, embeddings, image/audio transcription) |
| `GraphStorage`     | `pkg/store`  | Graph persistence and querying                                     |
| `WorkflowStorage`  | `pkg/store`  | Durable workflow run and step persistence                          |
| `GraphFileLoader`  | `pkg/loader` | File content loading from any source                               |
| `GraphQueryClient` | `pkg/query`  | Query execution with local/global/tool modes                       |
| `LoggerInstance`   | `pkg/logger` | Logging backend                                                    |

The durable workflow runtime lives in `pkg/workflow` and provides replayable
workflow execution, memoized steps, durable sleep, child workflows, and a
standalone worker that uses `WorkflowStorage` for persistence.

### Built-in Adapters

| Adapter    | Package              | Description                                    |
| ---------- | -------------------- | ---------------------------------------------- |
| OpenAI     | `pkg/ai/openai`      | OpenAI API for chat, embeddings, vision, audio |
| Ollama     | `pkg/ai/ollama`      | Local LLM inference via Ollama                 |
| PostgreSQL | `pkg/store/pgx`      | Graph storage with pgvector                    |
| Console    | `pkg/logger/console` | Structured console logging                     |

### Built-in File Loaders

Base loaders (implement `GraphFileLoader`):

| Loader | Package         | Description                  |
| ------ | --------------- | ---------------------------- |
| S3     | `pkg/loader/s3` | S3-compatible object storage |
| IO     | `pkg/loader/io` | Local filesystem             |

Processing loaders (wrap base loaders to transform content):

| Loader | Package            | Description                               |
| ------ | ------------------ | ----------------------------------------- |
| PDF    | `pkg/loader/pdf`   | PDF text extraction with optional OCR     |
| Doc    | `pkg/loader/doc`   | Word document extraction (.docx, .doc)    |
| PPTX   | `pkg/loader/pptx`  | PowerPoint extraction via OCR             |
| Excel  | `pkg/loader/excel` | Excel to CSV conversion                   |
| CSV    | `pkg/loader/csv`   | CSV parsing to text                       |
| Image  | `pkg/loader/image` | AI vision description                     |
| Audio  | `pkg/loader/audio` | AI audio transcription                    |
| OCR    | `pkg/loader/ocr`   | AI-powered text extraction from images    |
| Web    | `pkg/loader/web`   | Web page content extraction (readability) |

---

## Configuration

Copy `.env.sample` to `.env` and configure:

<details>
<summary><strong>Environment Variables</strong></summary>

| Variable                 | Description                        |
| ------------------------ | ---------------------------------- |
| `DEBUG`                  | Enable debug mode                  |
| `PORT`                   | Server port (default: 8080)        |
| `AUTH_SECRET`            | Secret key for authentication      |
| `AUTH_URL`               | Authentication service URL         |
| `APPLE_CLIENT_ID`        | Apple OAuth client ID              |
| `APPLE_CLIENT_SECRET`    | Apple OAuth client secret          |
| `APPLE_BUNDLE_ID`        | Apple bundle identifier (optional) |
| `GOOGLE_CLIENT_ID`       | Google OAuth client ID             |
| `GOOGLE_CLIENT_SECRET`   | Google OAuth client secret         |
| `MICROSOFT_CLIENT_ID`    | Microsoft OAuth client ID          |
| `MICROSOFT_CLIENT_SECRET`| Microsoft OAuth client secret      |
| `MICROSOFT_TENANT_ID`    | Microsoft tenant ID (optional)     |
| `MICROSOFT_AUTHORITY_URL`| Microsoft authority URL (optional) |
| `LDAP_URL`               | LDAP server URL                    |
| `LDAP_BIND_DN`           | LDAP bind DN                       |
| `LDAP_PASSW`             | LDAP bind password                 |
| `LDAP_BASE_DN`           | LDAP base DN                       |
| `LDAP_SEARCH_ATTR`       | LDAP search attribute              |
| `MASTER_API_KEY`         | Master API key for authentication  |
| `MASTER_USER_ID`         | Master user ID (string)            |
| `MASTER_USER_ROLE`       | Master user role (e.g., admin)     |
| `MASTER_USER_NAME`       | Optional display name for the bootstrapped master user |
| `MASTER_USER_EMAIL`      | Optional email for the bootstrapped master user |
| `NEXT_PUBLIC_API_URL`    | Frontend API base URL              |
| `NEXT_PUBLIC_AUTH_URL`   | Frontend auth base URL             |
| `DATABASE_URL`           | PgBouncer PostgreSQL connection string |
| `DATABASE_DIRECT_URL`    | Direct PostgreSQL connection string for migrations |
| `AWS_REGION`             | S3 region                          |
| `AWS_ENDPOINT`           | RustFS/S3 endpoint                 |
| `AWS_PUBLIC_ENDPOINT`    | Public S3 endpoint (for file URLs) |
| `AWS_ACCESS_KEY`         | S3 access key                      |
| `AWS_SECRET_KEY`         | S3 secret key                      |
| `AWS_BUCKET`             | S3 bucket name                     |
| `AI_ADAPTER`             | `openai` or `ollama`               |
| `AI_PARALLEL_REQ`        | Max parallel AI requests           |
| `AI_TIMEOUT_WORKER`      | Worker AI timeout minutes (<=0 for unlimited, mapped to `AI_TIMEOUT`) |
| `AI_TIMEOUT_SERVER`      | Server AI timeout minutes (<=0 for unlimited, mapped to `AI_TIMEOUT`) |
| `AI_CHAT_KEY`            | Chat API key                       |
| `AI_CHAT_URL`            | Chat model endpoint                |
| `AI_CHAT_MODEL`          | Model for descriptions             |
| `AI_EXTRACT_KEY`         | Extract API key                    |
| `AI_EXTRACT_URL`         | Extract model endpoint             |
| `AI_EXTRACT_MODEL`       | Model for extraction               |
| `AI_IMAGE_KEY`           | Image API key                      |
| `AI_IMAGE_URL`           | Image/OCR endpoint                 |
| `AI_IMAGE_MODEL`         | Image model name                   |
| `PDF_RENDER_MODE`        | PDF render mode: `auto`, `full`, `tile` |
| `PDF_DPI_DEFAULT`        | DPI for normal PDF pages           |
| `PDF_DPI_LARGE_PAGE`     | DPI for large/tiled PDF pages      |
| `PDF_PREVIEW_DPI`        | Low-res DPI used for layout detection |
| `PDF_TILE_MAX_EDGE_PX`   | Maximum tile width/height in pixels |
| `PDF_TILE_OVERLAP_PX`    | Tile overlap in pixels             |
| `PDF_LARGE_PAGE_EDGE_THRESHOLD_PX` | Edge threshold to classify a page as large |
| `PDF_LARGE_PAGE_AREA_THRESHOLD_PX` | Area threshold to classify a page as large |
| `PDF_ENABLE_PANEL_SPLIT` | Enable region-aware panel splitting before tiling |
| `PDF_PANEL_SEPARATOR_MIN_COVERAGE` | Separator detection sensitivity for panel split |
| `PDF_MAX_TILES_PER_PAGE` | Safety cap for tiles generated per page |
| `AI_EMBED_KEY`           | Embedding API key                  |
| `AI_EMBED_URL`           | Embedding endpoint                 |
| `AI_EMBED_MODEL`         | Embedding model name               |
| `WORKFLOW_WORKER_CONCURRENCY` | Parallel workflow runs per worker process |
| `WORKFLOW_MAX_ATTEMPTS`  | Retry limit for process/delete/description workflows |

### Optional: Clarifying Questions (Agentic Queries)

Agentic queries can optionally ask clarifying questions when a user request is
ambiguous or underspecified.

- `AI_ENABLE_QUERY_CLARIFICATION` (default: `false`): when enabled, agentic mode
  exposes a client tool (`ask_clarifying_questions`). If called, the backend
  returns the tool call metadata and waits for a follow-up request. In that
  follow-up request, set `tool_id` and send the tool answer in `prompt`.

### Optional: Large PDF OCR Rendering

For large-format documents (for example A1/A0 technical drawings), the backend
can switch from full-page rendering to adaptive tiled rendering.

- `PDF_RENDER_MODE=auto` enables adaptive behavior per page.
- `PDF_ENABLE_PANEL_SPLIT=true` enables region-aware splitting (left/right text
  strips, bottom legend blocks) before tile generation.
- Increase `PDF_DPI_LARGE_PAGE` to improve tiny text extraction, and reduce
  `PDF_TILE_MAX_EDGE_PX` if your vision model downscales large images heavily.

Note: When all LDAP variables are set, LDAP sign-in is enabled and email/password auth is disabled.

</details>

---

## AGENTS.md

| Document                                 | Description                                |
| ---------------------------------------- | ------------------------------------------ |
| [Root AGENTS.md](AGENTS.md)              | Project overview, architecture, workflows  |
| [Backend AGENTS.md](backend/AGENTS.md)   | Go conventions, sqlc, testing              |
| [Frontend AGENTS.md](frontend/AGENTS.md) | React patterns, TanStack Query, components |

---

## License

[MIT](LICENSE)
