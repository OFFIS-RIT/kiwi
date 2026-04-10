build:
	@cd backend && make generate
	@cd ../
	@docker build -f postgres/Dockerfile -t ghcr.io/offis-rit/kiwi/postgres:latest ./postgres/
	@docker build -f postgres/Dockerfile.migration -t ghcr.io/offis-rit/kiwi/postgres-migration:latest .
	@docker build -f backend/Dockerfile.server -t ghcr.io/offis-rit/kiwi/server:latest ./backend/
	@docker build -f backend/Dockerfile.worker -t ghcr.io/offis-rit/kiwi/worker:latest ./backend/
	@docker build -f frontend/Dockerfile -t ghcr.io/offis-rit/kiwi/frontend:latest ./frontend
	@docker build -f auth/Dockerfile -t ghcr.io/offis-rit/kiwi/auth:latest ./auth/

build-dev:
	@cd backend && make generate
	@cd ../
	@docker build -f postgres/Dockerfile -t ghcr.io/offis-rit/kiwi/postgres:dev ./postgres/
	@docker build -f postgres/Dockerfile.migration -t ghcr.io/offis-rit/kiwi/postgres-migration:dev .
	@docker build -f backend/Dockerfile.server.dev -t ghcr.io/offis-rit/kiwi/server:dev ./backend/
	@docker build -f backend/Dockerfile.worker.dev -t ghcr.io/offis-rit/kiwi/worker:dev ./backend/
	@docker build -f frontend/Dockerfile.dev -t ghcr.io/offis-rit/kiwi/frontend:dev ./frontend/
	@docker build -f auth/Dockerfile.dev -t ghcr.io/offis-rit/kiwi/auth:dev ./auth/

start:
	@docker compose -f compose.prod.yml up -d --scale worker=8

stop:
	@docker compose -f compose.prod.yml down

pull:
	@docker pull ghcr.io/offis-rit/kiwi/postgres:latest
	@docker pull ghcr.io/offis-rit/kiwi/postgres-migration:latest
	@docker pull ghcr.io/offis-rit/kiwi/api:latest
	@docker pull ghcr.io/offis-rit/kiwi/worker:latest
	@docker pull ghcr.io/offis-rit/kiwi/frontend:latest

dev:
	@echo "Starting development infrastructure..."
	@docker compose up -d
	@echo "Infrastructure is ready. Start the apps with: bun run dev"

dev-backend:
	@$(MAKE) dev

dev-stop:
	@echo "Stopping development infrastructure..."
	@docker compose down --remove-orphans

ROOT_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
ENV_FILE := $(ROOT_DIR).env
migrate:
	@set -a; \
		if [ -f "$(ENV_FILE)" ]; then . "$(ENV_FILE)"; fi; \
		set +a; \
		export AI_EMBED_DIM=$${AI_EMBED_DIM:-4096}; \
		MIGRATION_IMAGE=$$(docker build -q -f postgres/Dockerfile.migration .); \
		docker run --rm \
			-v $(ROOT_DIR)migrations:/app/migrations:ro \
			--network kiwi_internal \
			-e DATABASE_URL="$${DATABASE_DIRECT_URL_INTERNAL:-$${DATABASE_DIRECT_URL:-postgresql://kiwi:kiwi@db:5432/kiwi?sslmode=disable}}" \
			-e AI_EMBED_DIM \
			-e MASTER_USER_ID \
			-e MASTER_USER_ROLE \
			-e MASTER_USER_NAME \
			-e MASTER_USER_EMAIL \
			$$MIGRATION_IMAGE

db-dump:
	@set -a; \
		if [ -f "$(ENV_FILE)" ]; then . "$(ENV_FILE)"; fi; \
		set +a; \
		mkdir -p $(ROOT_DIR).backup; \
		DUMP_FILE="kiwi_$$(date +%Y%m%d_%H%M%S).dump"; \
		echo "Creating database dump: .backup/$$DUMP_FILE"; \
		docker run --rm \
			-v $(ROOT_DIR).backup:/backups \
			--network kiwi_internal \
			postgres:18 \
			pg_dump "$${DATABASE_URL_INTERNAL:-$${DATABASE_URL}}" -Fc -f "/backups/$$DUMP_FILE"; \
		echo "Backup complete: backups/$$DUMP_FILE"

DUMP_FILE ?=
db-restore:
	@if [ -z "$(DUMP_FILE)" ]; then \
		echo "Error: DUMP_FILE is required"; \
		echo "Usage: make db-restore DUMP_FILE=kiwi_YYYYMMDD_HHMMSS.dump"; \
		exit 1; \
	fi
	@DUMP_PATH="$(DUMP_FILE)"; \
		if [ ! -f "$$DUMP_PATH" ] && [ -f "$(ROOT_DIR).backup/$(DUMP_FILE)" ]; then \
			DUMP_PATH="$(ROOT_DIR).backup/$(DUMP_FILE)"; \
		fi; \
		if [ ! -f "$$DUMP_PATH" ]; then \
			echo "Error: File not found: $(DUMP_FILE)"; \
			exit 1; \
		fi; \
		set -a; \
		if [ -f "$(ENV_FILE)" ]; then . "$(ENV_FILE)"; fi; \
		set +a; \
		echo "Restoring database from: $$DUMP_PATH"; \
		docker run --rm \
			-v $(ROOT_DIR).backup:/backups \
			--network kiwi_internal \
			postgres:18 \
			pg_restore --clean --if-exists -d "$${DATABASE_URL_INTERNAL:-$${DATABASE_URL}}" "/backups/$$(basename $$DUMP_PATH)"; \
		echo "Restore complete"

.PHONY: build build-dev start stop pull dev dev-backend dev-stop migrate db-dump db-restore
