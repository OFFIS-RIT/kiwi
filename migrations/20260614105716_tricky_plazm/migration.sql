ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "valid_until" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "sources_current_id_idx"
    ON "sources" ("id")
    WHERE "active" = true AND "valid_until" IS NULL;

CREATE INDEX IF NOT EXISTS "sources_entity_current_id_idx"
    ON "sources" ("entity_id", "id")
    WHERE "active" = true AND "valid_until" IS NULL AND "entity_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "sources_relationship_current_id_idx"
    ON "sources" ("relationship_id", "id")
    WHERE "active" = true AND "valid_until" IS NULL AND "relationship_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "connectors" (
    "id" text PRIMARY KEY NOT NULL,
    "provider" text NOT NULL,
    "name" text NOT NULL,
    "slug" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "app_id" text,
    "app_slug" text,
    "client_id" text,
    "encrypted_credentials" text NOT NULL,
    "webhook_secret_encrypted" text NOT NULL,
    "created_by_user_id" text,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "connectors_slug_unique" UNIQUE("slug"),
    CONSTRAINT "connectors_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null,
    CONSTRAINT "connectors_provider_check" CHECK ("connectors"."provider" in ('github', 'gitlab')),
    CONSTRAINT "connectors_status_check" CHECK ("connectors"."status" in ('draft', 'active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS "connector_installations" (
    "id" text PRIMARY KEY NOT NULL,
    "connector_id" text NOT NULL,
    "provider" text NOT NULL,
    "provider_installation_id" text NOT NULL,
    "provider_account_login" text NOT NULL,
    "provider_account_type" text,
    "organization_id" text,
    "team_id" text,
    "installed_by_user_id" text,
    "encrypted_credentials" text,
    "repository_selection" text DEFAULT 'unknown' NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "connector_installations_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade,
    CONSTRAINT "connector_installations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade,
    CONSTRAINT "connector_installations_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade,
    CONSTRAINT "connector_installations_installed_by_user_id_user_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null,
    CONSTRAINT "connector_installations_provider_check" CHECK ("connector_installations"."provider" in ('github', 'gitlab')),
    CONSTRAINT "connector_installations_status_check" CHECK ("connector_installations"."status" in ('active', 'disabled')),
    CONSTRAINT "connector_installations_owner_scope_check" CHECK (("organization_id" is not null and "team_id" is null) or ("organization_id" is not null and "team_id" is not null))
);

CREATE TABLE IF NOT EXISTS "repository_graph_bindings" (
    "id" text PRIMARY KEY NOT NULL,
    "graph_id" text NOT NULL,
    "connector_installation_id" text NOT NULL,
    "provider" text NOT NULL,
    "provider_repository_id" text NOT NULL,
    "repository_full_name" text NOT NULL,
    "repository_html_url" text NOT NULL,
    "branch" text NOT NULL,
    "last_seen_commit_sha" text,
    "last_synced_commit_sha" text,
    "sync_status" text DEFAULT 'pending' NOT NULL,
    "sync_error_code" text,
    "webhook_enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "repository_graph_bindings_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade,
    CONSTRAINT "repository_graph_bindings_connector_installation_id_fk" FOREIGN KEY ("connector_installation_id") REFERENCES "public"."connector_installations"("id") ON DELETE restrict,
    CONSTRAINT "repository_graph_bindings_provider_check" CHECK ("repository_graph_bindings"."provider" in ('github', 'gitlab')),
    CONSTRAINT "repository_graph_bindings_sync_status_check" CHECK ("repository_graph_bindings"."sync_status" in ('pending', 'syncing', 'synced', 'failed'))
);

CREATE TABLE IF NOT EXISTS "connector_webhook_events" (
    "id" text PRIMARY KEY NOT NULL,
    "connector_id" text NOT NULL,
    "provider" text NOT NULL,
    "delivery_id" text NOT NULL,
    "event_name" text NOT NULL,
    "provider_repository_id" text,
    "branch" text,
    "commit_sha" text,
    "status" text NOT NULL,
    "error_code" text,
    "created_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "connector_webhook_events_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade,
    CONSTRAINT "connector_webhook_events_provider_check" CHECK ("connector_webhook_events"."provider" in ('github', 'gitlab')),
    CONSTRAINT "connector_webhook_events_status_check" CHECK ("connector_webhook_events"."status" in ('ignored', 'enqueued', 'duplicate', 'failed'))
);

ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "repository_binding_id" text;
ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "files_external_provider_check";
ALTER TABLE "files" ADD CONSTRAINT "files_external_provider_check" CHECK ("external_provider" IS NULL OR "external_provider" in ('github', 'gitlab'));
ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "files_repository_binding_id_repository_graph_bindings_id_fk";
ALTER TABLE "files" ADD CONSTRAINT "files_repository_binding_id_repository_graph_bindings_id_fk" FOREIGN KEY ("repository_binding_id") REFERENCES "public"."repository_graph_bindings"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "connectors_provider_status_idx" ON "connectors" ("provider", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "connector_installations_org_scope_unique" ON "connector_installations" ("connector_id", "provider_installation_id", "organization_id") WHERE "team_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "connector_installations_team_scope_unique" ON "connector_installations" ("connector_id", "provider_installation_id", "organization_id", "team_id") WHERE "team_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "connector_installations_connector_status_idx" ON "connector_installations" ("connector_id", "status");
CREATE INDEX IF NOT EXISTS "connector_installations_organization_idx" ON "connector_installations" ("organization_id");
CREATE INDEX IF NOT EXISTS "connector_installations_team_idx" ON "connector_installations" ("team_id");
CREATE UNIQUE INDEX IF NOT EXISTS "repository_graph_bindings_graph_unique" ON "repository_graph_bindings" ("graph_id");
CREATE UNIQUE INDEX IF NOT EXISTS "repository_graph_bindings_repository_branch_unique" ON "repository_graph_bindings" ("connector_installation_id", "provider_repository_id", "branch");
CREATE INDEX IF NOT EXISTS "repository_graph_bindings_provider_repo_branch_idx" ON "repository_graph_bindings" ("provider", "provider_repository_id", "branch");
CREATE INDEX IF NOT EXISTS "repository_graph_bindings_installation_status_idx" ON "repository_graph_bindings" ("connector_installation_id", "sync_status");
CREATE UNIQUE INDEX IF NOT EXISTS "connector_webhook_events_delivery_unique" ON "connector_webhook_events" ("connector_id", "provider", "delivery_id");
CREATE INDEX IF NOT EXISTS "connector_webhook_events_binding_lookup_idx" ON "connector_webhook_events" ("provider", "provider_repository_id", "branch");
CREATE INDEX IF NOT EXISTS "files_repository_binding_active_idx" ON "files" ("repository_binding_id", "created_at", "id") WHERE "deleted" = false;
