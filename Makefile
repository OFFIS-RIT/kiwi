build:
	@cd backend && make generate
	@cd ../
	@docker build -f backend/Dockerfile.postgres -t kiwi/postgres ./backend/
	@docker build -f backend/Dockerfile.server -t kiwi/server ./backend/
	@docker build -f backend/Dockerfile.worker -t kiwi/worker ./backend/
	@docker build -f frontend/Dockerfile -t kiwi/frontend ./frontend
	@docker build -f frontend/Dockerfile --target builder -t kiwi/frontend:builder ./frontend
	@docker build -f auth/Dockerfile -t kiwi/auth ./auth/

build-dev:
	@cd backend && make generate
	@cd ../
	@docker build -f backend/Dockerfile.postgres -t kiwi/postgres ./backend/
	@docker build -f backend/Dockerfile.server.dev -t kiwi/server-dev ./backend/
	@docker build -f backend/Dockerfile.worker.dev -t kiwi/worker-dev ./backend/
	@docker build -f frontend/Dockerfile.dev -t kiwi/frontend-dev:latest ./frontend/
	@docker build -f auth/Dockerfile.dev -t kiwi/auth-dev ./auth/

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

REGISTRY := ghcr.io/offis-rit/kiwi
TAG ?= latest

pull:
	@docker pull $(REGISTRY)/postgres:$(TAG)
	@docker pull $(REGISTRY)/server:$(TAG)
	@docker pull $(REGISTRY)/worker:$(TAG)
	@docker pull $(REGISTRY)/frontend:$(TAG)
	@docker pull $(REGISTRY)/frontend:$(TAG)-builder
	@docker pull $(REGISTRY)/auth:$(TAG)
	@docker tag $(REGISTRY)/postgres:$(TAG) kiwi/postgres:latest
	@docker tag $(REGISTRY)/server:$(TAG) kiwi/server:latest
	@docker tag $(REGISTRY)/worker:$(TAG) kiwi/worker:latest
	@docker tag $(REGISTRY)/frontend:$(TAG) kiwi/frontend:latest
	@docker tag $(REGISTRY)/frontend:$(TAG)-builder kiwi/frontend:builder
	@docker tag $(REGISTRY)/auth:$(TAG) kiwi/auth:latest

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
			postgres:17 \
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
			postgres:17 \
			pg_restore --clean --if-exists -d "$${DATABASE_URL}" "/backups/$$(basename $$DUMP_PATH)"; \
		echo "Restore complete"

.PHONY: build build-dev start stop dev dev-backend dev-stop migrate pull db-dump db-restore
