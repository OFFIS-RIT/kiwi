<p align="center">
  <img src="frontend/app/KIWI.jpg" alt="KIWI Logo" width="200" />
</p>

<h1 align="center">KIWI</h1>

<p align="center">
  <strong>Knowledge Graph Platform for Document Processing and AI-powered Q&A created by <a href="https://www.offis.de/">OFFIS e.V.</a></strong>
</p>

<p align="center">
  <img alt="Bun" src="https://img.shields.io/badge/bun-1.x-black?style=flat-square&logo=bun" />
  <img alt="Next.js" src="https://img.shields.io/badge/next.js-16-black?style=flat-square&logo=next.js" />
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#production">Production</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#library-usage">Library Usage</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#development">Development</a> •
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
- **Authentication & Authorization** – better-auth with JWT, role-based access
  control (admin/manager/user), LDAP and email/password modes
- **User Management** – Admin panel for managing users, roles, and bans
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
| Auth     | better-auth (Elysia, JWT, Admin plugin, LDAP)           |
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

# Start development infrastructure
docker compose up -d

# Start frontend, API, and worker
bun run dev
```

The application will be available at:

- **Frontend**: http://localhost:3000
- **API**: http://localhost:4321
- **Auth Routes**: http://localhost:4321/auth

Database migrations are run manually in local development after the
infrastructure is up.

### First Time Setup

The `rustfs-setup` container automatically creates the S3 bucket on first start.

For local AI with Ollama:

```bash
docker exec -it ollama ollama pull <model-name>
```

---

## Production

```bash
docker compose -f compose.prod.yml up -d  # Start production
docker compose -f compose.prod.yml down   # Stop production
```

`compose.prod.yml` also runs the `migrations` startup container automatically,
which applies pending migrations before app services connect to the database.

### SSL/TLS

Production uses Caddy as the edge proxy. The checked-in `compose.prod.yml`
mounts `./caddy/Caddyfile`, reads `APP_DOMAIN`, and does not require
certificate files in `./certs`.

### Production Services

| Service    | Description                    |
| ---------- | ------------------------------ |
| caddy      | Edge proxy with HTTPS          |
| frontend   | Frontend static site           |
| server     | Bun API server with `/auth`    |
| worker     | Durable workflow worker        |
| migrations | Startup migration job          |
| postgres   | PostgreSQL + pgvector          |
| bouncer    | PostgreSQL connection pool     |
| rustfs     | S3-compatible storage          |

---

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌─────────────┐
│   Frontend   │────▶│    Caddy     │────▶│   Server    │
│  (Next.js)   │     │   (prod)     │     │    (Bun)    │
└──────────────┘     └──────────────┘     └─────────────┘
       │                                         │
       ▼                                         ▼
┌──────────────┐                          ┌─────────────┐
│    Auth      │                          │  PostgreSQL │
│  (/auth)     │                          │  + pgvector │
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

| Mode    | API            | Description                                                              |
| ------- | -------------- | ------------------------------------------------------------------------ |
| Normal  | `mode=normal`  | Vector similarity search with path finding between relevant entities     |
| Agentic | `mode=agentic` | Agentic exploration using graph tools for autonomous knowledge discovery |

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

| Variable                           | Description                                                           |
| ---------------------------------- | --------------------------------------------------------------------- |
| `LOG_LEVEL`                        | API log level                                                         |
| `APP_DOMAIN`                       | Public domain used by Caddy for HTTPS and `/s3` proxying              |
| `AUTH_SECRET`                      | Secret key for authentication                                         |
| `AUTH_URL`                         | Public auth base URL                                                  |
| `WORKER_CONCURRENCY`               | Maximum number of workflow runs processed in parallel by the worker   |
| `NEXT_PUBLIC_API_URL`              | Frontend API base URL                                                 |
| `NEXT_PUBLIC_AUTH_URL`             | Frontend auth service base URL                                        |
| `NEXT_PUBLIC_AUTH_MODE`            | Frontend auth UI mode (see below)                                     |
| `NEXT_PUBLIC_APP_BUILD_LABEL`      | Optional frontend build label                                         |
| `APPLE_CLIENT_ID`                  | Apple OAuth client ID                                                 |
| `APPLE_CLIENT_SECRET`              | Apple OAuth client secret                                             |
| `APPLE_BUNDLE_ID`                  | Apple bundle identifier (optional)                                    |
| `GOOGLE_CLIENT_ID`                 | Google OAuth client ID                                                |
| `GOOGLE_CLIENT_SECRET`             | Google OAuth client secret                                            |
| `MICROSOFT_CLIENT_ID`              | Microsoft OAuth client ID                                             |
| `MICROSOFT_CLIENT_SECRET`          | Microsoft OAuth client secret                                         |
| `MICROSOFT_TENANT_ID`              | Microsoft tenant ID (optional)                                        |
| `MICROSOFT_AUTHORITY_URL`          | Microsoft authority URL (optional)                                    |
| `LDAP_URL`                         | LDAP server URL                                                       |
| `LDAP_BIND_DN`                     | LDAP bind DN                                                          |
| `LDAP_PASSW`                       | LDAP bind password                                                    |
| `LDAP_BASE_DN`                     | LDAP base DN                                                          |
| `LDAP_SEARCH_ATTR`                 | LDAP search attribute                                                 |
| `MASTER_USER_ID`                   | Master user ID (string)                                               |
| `MASTER_USER_ROLE`                 | Master user role (e.g., admin)                                        |
| `MASTER_USER_NAME`                 | Optional display name for the bootstrapped master user                |
| `MASTER_USER_EMAIL`                | Optional email for the bootstrapped master user                       |
| `DATABASE_URL`                     | Host PgBouncer PostgreSQL connection string                           |
| `OPENWORKFLOW_POSTGRES_URL`        | Host OpenWorkflow PostgreSQL connection string                        |
| `DATABASE_DIRECT_URL`              | Host direct PostgreSQL connection string                              |
| `DATABASE_URL_INTERNAL`            | Internal PgBouncer URL for Compose containers                         |
| `OPENWORKFLOW_POSTGRES_URL_INTERNAL` | Internal OpenWorkflow URL for Compose containers                    |
| `DATABASE_DIRECT_URL_INTERNAL`     | Internal direct PostgreSQL URL for migrations                         |
| `S3_REGION`                        | S3 region                                                             |
| `S3_ENDPOINT`                      | Host RustFS endpoint                                                  |
| `S3_ENDPOINT_INTERNAL`             | Internal RustFS endpoint for Compose containers                       |
| `TLS_EMAIL`                        | Optional ACME contact email used by Caddy                             |
| `S3_ACCESS_KEY_ID`                 | S3 access key                                                         |
| `S3_SECRET_ACCESS_KEY`             | S3 secret key                                                         |
| `S3_BUCKET`                        | S3 bucket name                                                        |
| `AI_TEXT_ADAPTER`                  | Text model adapter: `openai`, `azure`, `anthropic`, `openaiAPI`      |
| `AI_TEXT_MODEL`                    | Text model name                                                       |
| `AI_TEXT_KEY`                      | Text model API key                                                    |
| `AI_TEXT_URL`                      | Optional OpenAI-compatible text endpoint                              |
| `AI_TEXT_RESOURCE_NAME`            | Azure resource name for text models                                   |
| `AI_EMBEDDING_ADAPTER`             | Embedding adapter: `openai`, `azure`, `openaiAPI`                    |
| `AI_EMBEDDING_MODEL`               | Embedding model name                                                  |
| `AI_EMBEDDING_KEY`                 | Embedding API key                                                     |
| `AI_EMBEDDING_URL`                 | Optional OpenAI-compatible embedding endpoint                         |
| `AI_EMBEDDING_RESOURCE_NAME`       | Azure resource name for embeddings                                    |
| `AI_IMAGE_*`                       | Optional image / vision model configuration                           |
| `AI_AUDIO_*`                       | Optional audio model configuration                                    |
| `AI_EMBED_DIM`                     | Embedding dimension used by migrations                                |
| `OTEL_EXPORTER_OTLP_*`             | Optional OpenTelemetry log export configuration                       |

### Authentication Mode (Credentials vs LDAP)

Authentication mode is configured **independently** on the backend and frontend — they must match:

- **API/auth backend:** LDAP is auto-enabled when **all** LDAP env vars are
  present (`LDAP_URL`, `LDAP_BIND_DN`, `LDAP_PASSW`, `LDAP_BASE_DN`,
  `LDAP_SEARCH_ATTR`). When LDAP is active, email/password sign-up and sign-in
  are **disabled** automatically.
- **Frontend:** `NEXT_PUBLIC_AUTH_MODE` controls which login form is shown.
  Set to `credentials` (default) for email/password or `ldap` for
  username/password via LDAP. It also hides the "Create User" button in admin
  when set to `ldap` (since user creation happens through LDAP).

If the two sides disagree (e.g., backend has LDAP enabled but frontend is set to
`credentials`), login will fail. Always set `NEXT_PUBLIC_AUTH_MODE=ldap` when
LDAP env vars are configured, and leave it as `credentials` (or unset) otherwise.

Note: When all LDAP variables are set, LDAP sign-in is enabled and email/password auth is disabled.

</details>

---

## Development

```bash
docker compose up -d  # Start PostgreSQL, PgBouncer, and RustFS
bun run dev           # Start frontend, API, and worker
docker compose down   # Stop infrastructure
```

Run database migrations manually after the infrastructure is up and before
starting the app processes. When `MASTER_USER_ID` is configured, the API also
ensures the matching user exists with the configured role and profile fields.

### Development Services

| Service    | Port       | Description                    |
| ---------- | ---------- | ------------------------------ |
| frontend   | 3000       | Next.js dev server             |
| server     | 4321       | Bun API server with `/auth`    |
| worker     | -          | Durable workflow worker        |
| postgres   | internal   | PostgreSQL + pgvector          |
| bouncer    | 5432       | PostgreSQL connection pool     |
| rustfs     | 9000, 9001 | S3-compatible storage          |

### Worker Runtime

The background worker (`apps/worker`) executes durable workflow runs stored in PostgreSQL.

- API requests enqueue `process`, `delete`, and `description` workflow runs transactionally.
- The worker polls pending runs, claims a lease, heartbeats while executing, and retries failures with backoff.
- File indexing fans out to one `process` workflow per file; once all file workflows in a correlation finish, description workflows are enqueued automatically.
- Delete operations use `delete` workflows and refresh affected descriptions before the project returns to `ready`.

```bash
# Start the full local stack
bun run dev

# Start only the worker
bun --cwd apps/worker run dev
```

---

## AGENTS.md

| Document                    | Description                            |
| --------------------------- | -------------------------------------- |
| [AGENTS.md](AGENTS.md)      | Repo technologies, commands, and style |

---

## License

[MIT](LICENSE)
