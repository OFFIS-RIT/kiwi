<p align="center">
  <img src="apps/frontend/public/KIWI.jpg" alt="KIWI Logo" width="200" />
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

- **Document Processing** – Upload and process PDFs, images, audio, CSV, and Excel files
- **Adaptive PDF OCR Rendering** – Automatically switches to high-resolution tiled rendering, with optional panel splitting for large technical drawings such as A1 and A0 sheets
- **Knowledge Graph Extraction** – Uses AI to extract entities, relationships, and supporting evidence from uploaded documents
- **Graph Storage** – Stores entities and relationships in a queryable knowledge graph backed by PostgreSQL and pgvector
- **Vector Search** – Supports semantic retrieval over extracted document content
- **Graph Exploration Tools** – Provides AI-assisted traversal, multi-hop path finding, and source-grounded exploration of graph data
- **Authentication & Authorization** – Uses Better Auth for sessions, roles, LDAP, and email/password sign-in
- **User Management** – Includes an admin UI for managing users, roles, and bans
- **Chat Interface** – Lets users ask questions about their documents with streaming responses in both normal and agentic modes
- **Multi-Model Support** – Works with OpenAI-compatible providers, OpenAI, Azure, Anthropic, and local inference backends where available

When using OpenAI reasoning models, temperature is fixed to `1.0`, as required by the provider.

## Tech Stack

| Layer    | Technology                                                  |
| -------- | ----------------------------------------------------------- |
| Frontend | Next.js 16, React 19, TanStack Query, Tailwind CSS, Bun     |
| Backend  | Bun, Elysia, Drizzle ORM                                    |
| Auth     | Better Auth with admin roles, LDAP, and email/password      |
| Database | PostgreSQL + pgvector                                        |
| Workflow | OpenWorkflow with PostgreSQL-backed durable workflow storage |
| Storage  | RustFS (S3-compatible)                                      |
| AI       | Vercel AI SDK with OpenAI, Azure, Anthropic, and compatible APIs |

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
# Edit .env with your AI credentials and local settings

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

If you want to use a local OpenAI-compatible model backend such as Ollama, point the AI settings in `.env` to that endpoint.

For example, with Ollama:

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
| frontend   | Next.js frontend               |
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

| Tool                        | Capability                                                                    |
| --------------------------- | ----------------------------------------------------------------------------- |
| `list_files`                | List files in the current graph and return file IDs for follow-up tool calls  |
| `search_entities`           | Find entities by name, alias, type, or short topical query                    |
| `list_entities`             | Scan entities broadly, optionally scoped to specific files                     |
| `search_relationships`      | Search relationships relevant to a query and return relationship IDs           |
| `get_relationships`         | Retrieve relationships for known entity IDs                                    |
| `get_entity_neighbours`     | Traverse directly connected entities from a selected entity                    |
| `get_path_between_entities` | Find multi-hop paths between two entities                                      |
| `get_sources`               | Retrieve source evidence and citation IDs for entities or relationships        |
| `ask_clarifying_questions`  | Ask the user for missing information when the graph and prior context are insufficient |

---

## Library Usage

KIWI is organized as a Bun workspace monorepo. The main applications and shared packages are:

| Package             | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `apps/frontend`     | Next.js frontend for document upload, graph browsing, admin flows, and chat |
| `apps/api`          | Elysia API server, auth bridge, route handlers, and OpenWorkflow integration |
| `apps/worker`       | Background worker that executes durable workflows for file processing        |
| `packages/ai`       | Shared AI adapters, prompt helpers, chat message types, and tool wiring     |
| `packages/auth`     | Better Auth server and client setup, permissions, and auth helpers          |
| `packages/db`       | Drizzle schema, tables, and database access                                 |
| `packages/files`    | Shared RustFS and S3 file utilities                                          |
| `packages/graph`    | Graph extraction, chunking, loaders, and processing logic                   |
| `packages/logger`   | Shared logging and OpenTelemetry helpers                                    |

This structure keeps frontend, API, worker, and shared business logic aligned while still allowing each app to ship independently.

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
| `TRUSTED_ORIGINS`                  | Comma-separated origins allowed to call auth/API with credentials     |
| `AUTH_CROSS_SUBDOMAIN_COOKIES`     | Enable Better Auth cross-subdomain cookies                            |
| `AUTH_COOKIE_DOMAIN`               | Optional cookie domain for shared auth sessions across subdomains     |
| `WORKER_CONCURRENCY`               | Maximum number of workflow runs processed in parallel by the worker   |
| `API_INTERNAL_URL`                 | URL the Next.js server uses for server-side API calls                 |
| `AUTH_MODE`                        | Frontend auth UI mode (see below)                                     |
| `APP_BUILD_LABEL`                  | Optional frontend build label                                         |
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
| `MASTER_USER_NAME`                 | Optional display name for the bootstrapped master user                |
| `MASTER_USER_EMAIL`                | Optional email for the bootstrapped master user                       |
| `MASTER_USER_PASSWORD`             | Optional password for bootstrapping a credential login for master user |
| `MASTER_USER_API_KEY`              | Optional Better Auth API key bound to the master user |
| `DATABASE_URL`                     | Host PgBouncer PostgreSQL connection string                           |
| `DATABASE_DIRECT_URL`              | Host direct PostgreSQL connection string                              |
| `S3_REGION`                        | S3 region                                                             |
| `S3_ENDPOINT`                      | Host RustFS endpoint                                                  |
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
| `AI_IMAGE_ADAPTER`                 | Optional image / vision model adapter                                 |
| `AI_IMAGE_MODEL`                   | Optional image / vision model name                                    |
| `AI_IMAGE_KEY`                     | Optional image / vision model API key                                 |
| `AI_IMAGE_URL`                     | Optional OpenAI-compatible image / vision endpoint                    |
| `AI_IMAGE_RESOURCE_NAME`           | Optional Azure resource name for image / vision models                |
| `AI_AUDIO_ADAPTER`                 | Optional audio model adapter                                          |
| `AI_AUDIO_MODEL`                   | Optional audio model name                                             |
| `AI_AUDIO_KEY`                     | Optional audio model API key                                          |
| `AI_AUDIO_URL`                     | Optional OpenAI-compatible audio endpoint                             |
| `AI_AUDIO_RESOURCE_NAME`           | Optional Azure resource name for audio models                         |
| `AI_TEXT_CONCURRENCY`              | Worker-local maximum concurrent text requests                         |
| `AI_IMAGE_CONCURRENCY`             | Worker-local maximum concurrent image requests                        |
| `AI_EMBEDDING_CONCURRENCY`         | Worker-local maximum concurrent embedding requests                    |
| `AI_AUDIO_CONCURRENCY`             | Worker-local maximum concurrent audio requests                        |
| `AI_EMBED_DIM`                     | Embedding dimension used by migrations                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT`      | Optional OTLP endpoint fallback for log export                        |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Optional OTLP logs endpoint                                           |
| `OTEL_EXPORTER_OTLP_HEADERS`       | Optional OTLP export headers                                          |

### Authentication Mode (Credentials vs LDAP)

Authentication mode is configured **independently** on the backend and frontend — they must match:

- **API/auth backend:** LDAP is auto-enabled when **all** LDAP env vars are
  present (`LDAP_URL`, `LDAP_BIND_DN`, `LDAP_PASSW`, `LDAP_BASE_DN`,
  `LDAP_SEARCH_ATTR`). When LDAP is active, email/password sign-up and sign-in
  are **disabled** automatically.
- **Frontend:** `AUTH_MODE` controls which login form is shown.
  Set to `credentials` (default) for email/password or `ldap` for
  username/password via LDAP. It also hides the "Create User" button in admin
  when set to `ldap` (since user creation happens through LDAP).

If the two sides disagree (e.g., backend has LDAP enabled but frontend is set to
`credentials`), login will fail. Always set `AUTH_MODE=ldap` when
LDAP env vars are configured, and leave it as `credentials` (or unset) otherwise.

Note: When all LDAP variables are set, LDAP sign-in is enabled and email/password auth is disabled.

### Cross-Subdomain Cookies

To share auth sessions across subdomains, configure the backend with:

- `TRUSTED_ORIGINS` set to a comma-separated list of frontend origins, for example `https://app.example.com,https://admin.example.com`
- `AUTH_CROSS_SUBDOMAIN_COOKIES=true`
- `AUTH_COOKIE_DOMAIN=.example.com` (or the most specific shared domain you need)

Example:

```env
AUTH_URL=https://auth.example.com/auth
TRUSTED_ORIGINS=https://app.example.com,https://admin.example.com
AUTH_CROSS_SUBDOMAIN_COOKIES=true
AUTH_COOKIE_DOMAIN=.example.com
```

When you deploy behind Caddy on one host, set `API_INTERNAL_URL` to the
container-internal server address:

```env
AUTH_URL=https://kiwi.example.com/auth
TRUSTED_ORIGINS=https://kiwi.example.com
API_INTERNAL_URL=http://server:4321
```

For local Bun development without Caddy, point the frontend at localhost:

```env
AUTH_URL=http://localhost:4321/auth
API_INTERNAL_URL=http://localhost:4321
```

OpenWorkflow uses `DATABASE_DIRECT_URL` instead of a separate workflow-specific connection variable.
Use `DATABASE_URL` for pooled application queries and `DATABASE_DIRECT_URL` for migrations and workflow storage.

For production, set these variables to the container-network endpoints used inside the Compose stack:

```env
DATABASE_URL=postgresql://kiwi:kiwi@bouncer:5432/kiwi?sslmode=disable
DATABASE_DIRECT_URL=postgresql://kiwi:kiwi@postgres:5432/kiwi?sslmode=disable
S3_ENDPOINT=http://rustfs:9000
```

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
ensures the matching user exists as an admin with the configured profile fields.
If `MASTER_USER_API_KEY` is also configured, the API bootstraps that value as a
managed Better Auth API key for the master user.

### Development Services

| Service    | Port       | Description                    |
| ---------- | ---------- | ------------------------------ |
| frontend   | 3000       | Next.js dev server             |
| server     | 4321       | Bun API server with `/auth`    |
| worker     | -          | Durable workflow worker        |
| postgres   | 5433       | Direct PostgreSQL connection   |
| bouncer    | 5432       | PgBouncer pooled connection    |
| rustfs     | 9000, 9001 | S3-compatible storage          |

### Worker Runtime

The background worker in `apps/worker` executes durable workflow runs stored in PostgreSQL.

- API requests enqueue `process`, `delete`, and `description` workflow runs transactionally.
- The worker polls pending runs, claims a lease, heartbeats while work is in progress, and retries failures with backoff.
- File indexing fans out to one `process` workflow per file. Once all file workflows in a correlation finish, description workflows are enqueued automatically.
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
