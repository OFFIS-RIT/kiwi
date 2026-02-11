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
	@docker compose -f compose.yml -f compose.prod.yml up -d

stop:
	@docker compose -f compose.yml -f compose.prod.yml down

dev:
	@echo "Starting development environment..."
	@docker compose -f compose.yml -f compose.dev.yml up -d
	@docker compose -f compose.yml -f compose.dev.yml logs -f server worker frontend

dev-backend:
	@echo "Starting development backend environment..."
	@docker compose -f compose.yml -f compose.dev.yml up -d --scale frontend=0
	@docker compose -f compose.yml -f compose.dev.yml logs -f server worker

dev-stop:
	@echo "Stoping development environment..."
	@docker compose -f compose.yml -f compose.dev.yml down --remove-orphans

ROOT_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
ENV_FILE := $(ROOT_DIR).env
migrate:
	@set -a; \
		if [ -f "$(ENV_FILE)" ]; then . "$(ENV_FILE)"; fi; \
		set +a; \
		export AI_EMBED_DIM=$${AI_EMBED_DIM:-4096}; \
		mkdir -p $(ROOT_DIR).migrations_processed; \
		for f in $(ROOT_DIR)migrations/*.sql; do \
			envsubst '$$AI_EMBED_DIM' < "$$f" > "$(ROOT_DIR).migrations_processed/$$(basename $$f)"; \
		done; \
		docker run --rm \
			-v $(ROOT_DIR).migrations_processed:/migrations \
			--network kiwi_internal \
			migrate/migrate \
			-path=/migrations \
			-database "$${DATABASE_URL}" \
			up; \
		rm -rf $(ROOT_DIR).migrations_processed

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
			pg_dump "$${DATABASE_URL}" -Fc -f "/backups/$$DUMP_FILE"; \
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
			pg_restore --clean --if-exists -d "$${DATABASE_URL}" "/backups/$$(basename $$DUMP_PATH)"; \
		echo "Restore complete"

.PHONY: build build-dev start stop dev dev-backend dev-stop migrate db-dump db-restore
