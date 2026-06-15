import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import { organizationTable, teamTable, userTable } from "./auth";
import { graphTable } from "./graph";

export const CONNECTOR_PROVIDER_VALUES = ["github", "gitlab"] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDER_VALUES)[number];

export const CONNECTOR_STATUS_VALUES = ["draft", "active", "disabled"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUS_VALUES)[number];

export const CONNECTOR_INSTALLATION_STATUS_VALUES = ["active", "disabled"] as const;
export type ConnectorInstallationStatus = (typeof CONNECTOR_INSTALLATION_STATUS_VALUES)[number];

export const REPOSITORY_GRAPH_SYNC_STATUS_VALUES = ["pending", "syncing", "synced", "failed"] as const;
export type RepositoryGraphSyncStatus = (typeof REPOSITORY_GRAPH_SYNC_STATUS_VALUES)[number];

export const CONNECTOR_WEBHOOK_EVENT_STATUS_VALUES = ["ignored", "enqueued", "duplicate", "failed"] as const;
export type ConnectorWebhookEventStatus = (typeof CONNECTOR_WEBHOOK_EVENT_STATUS_VALUES)[number];

export const connectorsTable = pgTable.withRLS(
    "connectors",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        provider: text("provider", { enum: CONNECTOR_PROVIDER_VALUES }).notNull(),
        name: text("name").notNull(),
        slug: text("slug").notNull(),
        status: text("status", { enum: CONNECTOR_STATUS_VALUES }).notNull().default("active"),
        appId: text("app_id"),
        appSlug: text("app_slug"),
        clientId: text("client_id"),
        encryptedCredentials: text("encrypted_credentials").notNull(),
        webhookSecretEncrypted: text("webhook_secret_encrypted").notNull(),
        createdByUserId: text("created_by_user_id").references(() => userTable.id, { onDelete: "set null" }),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        uniqueIndex("connectors_slug_unique").on(table.slug),
        index("connectors_provider_status_idx").on(table.provider, table.status),
        check("connectors_provider_check", sql`${table.provider} in ('github', 'gitlab')`),
        check("connectors_status_check", sql`${table.status} in ('draft', 'active', 'disabled')`),
    ]
);

export const connectorInstallationsTable = pgTable.withRLS(
    "connector_installations",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        connectorId: text("connector_id")
            .notNull()
            .references(() => connectorsTable.id, { onDelete: "cascade" }),
        provider: text("provider", { enum: CONNECTOR_PROVIDER_VALUES }).notNull(),
        providerInstallationId: text("provider_installation_id").notNull(),
        providerAccountLogin: text("provider_account_login").notNull(),
        providerAccountType: text("provider_account_type"),
        organizationId: text("organization_id").references(() => organizationTable.id, { onDelete: "cascade" }),
        teamId: text("team_id").references(() => teamTable.id, { onDelete: "cascade" }),
        installedByUserId: text("installed_by_user_id").references(() => userTable.id, { onDelete: "set null" }),
        encryptedCredentials: text("encrypted_credentials"),
        repositorySelection: text("repository_selection").notNull().default("unknown"),
        status: text("status", { enum: CONNECTOR_INSTALLATION_STATUS_VALUES }).notNull().default("active"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        unique("connector_installations_provider_scope_unique").on(
            table.connectorId,
            table.providerInstallationId,
            table.organizationId,
            table.teamId
        ),
        index("connector_installations_connector_status_idx").on(table.connectorId, table.status),
        index("connector_installations_organization_idx").on(table.organizationId),
        index("connector_installations_team_idx").on(table.teamId),
        check("connector_installations_provider_check", sql`${table.provider} in ('github', 'gitlab')`),
        check("connector_installations_status_check", sql`${table.status} in ('active', 'disabled')`),
        check(
            "connector_installations_owner_scope_check",
            sql`(${table.organizationId} is not null and ${table.teamId} is null) or (${table.organizationId} is not null and ${table.teamId} is not null)`
        ),
    ]
);

export const repositoryGraphBindingsTable = pgTable.withRLS(
    "repository_graph_bindings",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        graphId: text("graph_id")
            .notNull()
            .references(() => graphTable.id, { onDelete: "cascade" }),
        connectorInstallationId: text("connector_installation_id")
            .notNull()
            .references(() => connectorInstallationsTable.id, { onDelete: "restrict" }),
        provider: text("provider", { enum: CONNECTOR_PROVIDER_VALUES }).notNull(),
        providerRepositoryId: text("provider_repository_id").notNull(),
        repositoryFullName: text("repository_full_name").notNull(),
        repositoryHtmlUrl: text("repository_html_url").notNull(),
        branch: text("branch").notNull(),
        lastSeenCommitSha: text("last_seen_commit_sha"),
        lastSyncedCommitSha: text("last_synced_commit_sha"),
        syncStatus: text("sync_status", { enum: REPOSITORY_GRAPH_SYNC_STATUS_VALUES }).notNull().default("pending"),
        syncErrorCode: text("sync_error_code"),
        webhookEnabled: boolean("webhook_enabled").notNull().default(true),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        uniqueIndex("repository_graph_bindings_graph_unique").on(table.graphId),
        uniqueIndex("repository_graph_bindings_repository_branch_unique").on(
            table.connectorInstallationId,
            table.providerRepositoryId,
            table.branch
        ),
        index("repository_graph_bindings_provider_repo_branch_idx").on(
            table.provider,
            table.providerRepositoryId,
            table.branch
        ),
        index("repository_graph_bindings_installation_status_idx").on(table.connectorInstallationId, table.syncStatus),
        check("repository_graph_bindings_provider_check", sql`${table.provider} in ('github', 'gitlab')`),
        check(
            "repository_graph_bindings_sync_status_check",
            sql`${table.syncStatus} in ('pending', 'syncing', 'synced', 'failed')`
        ),
    ]
);

export const connectorWebhookEventsTable = pgTable.withRLS(
    "connector_webhook_events",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        connectorId: text("connector_id")
            .notNull()
            .references(() => connectorsTable.id, { onDelete: "cascade" }),
        provider: text("provider", { enum: CONNECTOR_PROVIDER_VALUES }).notNull(),
        deliveryId: text("delivery_id").notNull(),
        eventName: text("event_name").notNull(),
        providerRepositoryId: text("provider_repository_id"),
        branch: text("branch"),
        commitSha: text("commit_sha"),
        status: text("status", { enum: CONNECTOR_WEBHOOK_EVENT_STATUS_VALUES }).notNull(),
        errorCode: text("error_code"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    },
    (table) => [
        uniqueIndex("connector_webhook_events_delivery_unique").on(table.connectorId, table.provider, table.deliveryId),
        index("connector_webhook_events_binding_lookup_idx").on(table.provider, table.providerRepositoryId, table.branch),
        check("connector_webhook_events_provider_check", sql`${table.provider} in ('github', 'gitlab')`),
        check(
            "connector_webhook_events_status_check",
            sql`${table.status} in ('ignored', 'enqueued', 'duplicate', 'failed')`
        ),
    ]
);
