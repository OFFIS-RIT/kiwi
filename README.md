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
- **Knowledge Graph Extraction** – AI-powered entity and relationship extraction
- **Graph Storage** – Entities and relations stored as queryable knowledge graph
- **Vector Search** – Semantic search using pgvector embeddings
- **Graph Exploration Tools** – AI-powered tools for relationship traversal,
  multi-hop path finding, and autonomous knowledge exploration
- **Chat Interface** – Ask questions about your documents with streaming AI
  responses (fast, normal, or detailed modes)
- **Multi-Model Support** – Works with OpenAI API or local Ollama models
  - **Note:** When using OpenAI API with reasoning enabled, temperature is fixed
    to 1.0 (required by o-series and gpt-5+ models)

## Tech Stack

| Layer    | Technology                                              |
| -------- | ------------------------------------------------------- |
| Frontend | Next.js 16, React 19, TanStack Query, Tailwind CSS, Bun |
| Backend  | Go 1.25, Echo Framework, sqlc                           |
| Database | PostgreSQL + pgvector                                   |
| Queue    | RabbitMQ                                                |
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
make migrate          # Run database migrations
```

### Services

| Service  | Port        | Description           |
| -------- | ----------- | --------------------- |
| frontend | 3000        | Next.js dev server    |
| auth     | 4321        | Auth                  |
| server   | 8080        | Go API server         |
| db       | 5432        | PostgreSQL + pgvector |
| rabbitmq | 5672, 15672 | Message queue         |
| rustfs   | 9000, 9001  | S3-compatible storage |
| ollama   | 11434       | Local LLM inference   |

---

## Production

```bash
make build    # Build Docker images
make start    # Start production
make stop     # Stop production
```

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
┌──────────────┐     ┌──────────────┐            │
│   RabbitMQ   │◀───▶│    Worker    │────────────┘
│   (queue)    │     │ (background) │
└──────────────┘     └──────────────┘
       │                    │
       ▼                    ▼
┌──────────────┐     ┌──────────────┐
│    RustFS    │     │ Ollama/OpenAI│
│  (S3 files)  │     │   (AI/LLM)   │
└──────────────┘     └──────────────┘
```

### Processing Pipeline

1. User uploads files → API stores in RustFS
2. API publishes job to RabbitMQ
3. Worker processes files (PDF, images, audio, CSV, Excel)
4. Worker extracts entities/relations via AI
5. Worker stores graph in PostgreSQL with embeddings
6. User queries via chat → vector search, graph traversal, or agentic tool
   exploration + AI response

### Query Modes

| Mode     | API             | Description                                                              |
| -------- | --------------- | ------------------------------------------------------------------------ |
| Fast     | `mode=fast`     | Global entity aggregation for quick answers                              |
| Normal   | `mode=normal`   | Vector similarity search with path finding between relevant entities     |
| Detailed | `mode=detailed` | Agentic exploration using graph tools for autonomous knowledge discovery |

#### Graph Exploration Tools (Detailed Mode)

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
| `GraphFileLoader`  | `pkg/loader` | File content loading from any source                               |
| `GraphQueryClient` | `pkg/query`  | Query execution with local/global/tool modes                       |
| `LoggerInstance`   | `pkg/logger` | Logging backend                                                    |

### Built-in Adapters

| Adapter    | Package              | Description                                    |
| ---------- | -------------------- | ---------------------------------------------- |
| OpenAI     | `pkg/ai/openai`      | OpenAI API for chat, embeddings, vision, audio |
| Ollama     | `pkg/ai/ollama`      | Local LLM inference via Ollama                 |
| PostgreSQL | `pkg/store/base`     | Graph storage with pgvector                    |
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
| `MASTER_API_KEY`         | Master API key for authentication  |
| `MASTER_USER_ID`         | Master user ID (integer)           |
| `MASTER_USER_ROLE`       | Master user role (e.g., admin)     |
| `NEXT_PUBLIC_API_URL`    | Frontend API base URL              |
| `DATABASE_URL`           | PostgreSQL connection string       |
| `AWS_REGION`             | S3 region                          |
| `AWS_ENDPOINT`           | RustFS/S3 endpoint                 |
| `AWS_PUBLIC_ENDPOINT`    | Public S3 endpoint (for file URLs) |
| `AWS_ACCESS_KEY`         | S3 access key                      |
| `AWS_SECRET_KEY`         | S3 secret key                      |
| `AWS_BUCKET`             | S3 bucket name                     |
| `AI_ADAPTER`             | `openai` or `ollama`               |
| `AI_PARALLEL_REQ`        | Max parallel AI requests           |
| `AI_CHAT_KEY`            | Chat API key                       |
| `AI_CHAT_URL`            | Chat model endpoint                |
| `AI_CHAT_DESCRIBE_MODEL` | Model for descriptions             |
| `AI_CHAT_EXTRACT_MODEL`  | Model for extraction               |
| `AI_IMAGE_KEY`           | Image API key                      |
| `AI_IMAGE_URL`           | Image/OCR endpoint                 |
| `AI_IMAGE_MODEL`         | Image model name                   |
| `AI_EMBED_KEY`           | Embedding API key                  |
| `AI_EMBED_URL`           | Embedding endpoint                 |
| `AI_EMBED_MODEL`         | Embedding model name               |
| `RABBITMQ_USER`          | RabbitMQ username                  |
| `RABBITMQ_PASSWORD`      | RabbitMQ password                  |
| `RABBITMQ_HOST`          | RabbitMQ host                      |
| `RABBITMQ_PORT`          | RabbitMQ port                      |

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
