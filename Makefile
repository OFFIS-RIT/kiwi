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

.PHONY: build build-dev start stop dev dev-backend dev-stop migrate pull
