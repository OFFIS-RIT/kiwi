import { sql } from "drizzle-orm";
import {
    boolean,
    check,
    doublePrecision,
    foreignKey,
    index,
    integer,
    json,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uniqueIndex,
    vector,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import type { FileProcessErrorCode } from "@kiwi/contracts/routes";
import type { TextUnitSourceChunk } from "@kiwi/contracts/source";
import { organizationTable, teamTable, userTable } from "./auth";
import { tsvector, weightedTsvectorGenerated } from "./tsvector";

export const FILE_PROCESS_STATUS_VALUES = ["processing", "processed", "failed"] as const;
export type FileProcessStatus = (typeof FILE_PROCESS_STATUS_VALUES)[number];

export const FILE_PROCESS_STEP_VALUES = [
    "pending",
    "preprocessing",
    "metadata",
    "chunking",
    "extracting",
    "deduplicating",
    "saving",
    "completed",
    "failed",
] as const;
export type FileProcessStep = (typeof FILE_PROCESS_STEP_VALUES)[number];

export const PROCESS_RUN_STATUS_VALUES = ["pending", "started", "completed", "failed"] as const;
export type ProcessRunStatus = (typeof PROCESS_RUN_STATUS_VALUES)[number];

export const graphTable = pgTable.withRLS(
    "graphs",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        organizationId: text("organization_id").references(() => organizationTable.id, { onDelete: "cascade" }),
        teamId: text("team_id").references(() => teamTable.id, { onDelete: "cascade" }),
        userId: text("user_id").references(() => userTable.id, { onDelete: "cascade" }),
        graphId: text("graph_id").references((): AnyPgColumn => graphTable.id, { onDelete: "cascade" }),
        name: text("name").notNull(),
        description: text("description"),
        state: text("state", { enum: ["ready", "updating"] })
            .notNull()
            .default("ready"),
        type: text("type"),
        hidden: boolean("hidden").notNull().default(false),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        check(
            "graphs_single_owner_check",
            sql`(((${table.organizationId} IS NOT NULL)::int + (${table.userId} IS NOT NULL)::int + (${table.graphId} IS NOT NULL)::int) = 1)`
        ),
        check(
            "graphs_team_requires_organization_check",
            sql`${table.teamId} IS NULL OR ${table.organizationId} IS NOT NULL`
        ),
        foreignKey({
            name: "graphs_team_organization_fkey",
            columns: [table.teamId, table.organizationId],
            foreignColumns: [teamTable.id, teamTable.organizationId],
        }).onDelete("cascade"),
        index("graphs_organization_type_idx").on(table.organizationId, table.type),
        index("graphs_team_type_idx").on(table.teamId, table.type),
        index("graphs_user_type_idx").on(table.userId, table.type),
        index("graphs_graph_type_idx").on(table.graphId, table.type),
        index("graphs_name_trgm_idx").using("gin", table.name.op("gin_trgm_ops")),
        index("graphs_visible_root_organization_name_idx")
            .on(table.organizationId, table.name)
            .where(sql`${table.graphId} IS NULL AND ${table.teamId} IS NULL AND ${table.hidden} = false`),
        index("graphs_visible_root_team_name_idx")
            .on(table.teamId, table.name)
            .where(sql`${table.graphId} IS NULL AND ${table.hidden} = false`),
    ]
);

export const graphUpdateTable = pgTable.withRLS("graph_updates", {
    id: text("id")
        .primaryKey()
        .$default(() => ulid()),
    graphId: text("graph_id")
        .notNull()
        .references(() => graphTable.id, { onDelete: "cascade" }),
    updateType: text("update_type").notNull(),
    updateMessage: json("update_message").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
});

export const graphPromptsTable = pgTable.withRLS(
    "graph_prompts",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        graphId: text("graph_id")
            .notNull()
            .references(() => graphTable.id, { onDelete: "cascade" }),
        prompt: text("prompt").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [index("graph_prompts_graph_created_idx").on(table.graphId, table.createdAt, table.id)]
);

export const filesTable = pgTable.withRLS(
    "files",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        graphId: text("graph_id")
            .notNull()
            .references(() => graphTable.id, { onDelete: "cascade" }),
        name: text("name").notNull(),
        size: integer("file_size").notNull(),
        type: text("file_type").notNull(),
        mimeType: text("mime_type").notNull(),
        key: text("file_key").notNull(),
        storageKind: text("storage_kind").notNull().default("internal"),
        externalUrl: text("external_url"),
        externalProvider: text("external_provider"),
        repositoryBindingId: text("repository_binding_id"),
        checksum: text("checksum"),
        deleted: boolean("deleted").default(false),
        status: text("status", { enum: FILE_PROCESS_STATUS_VALUES }).notNull().default("processing"),
        processStep: text("process_step", { enum: FILE_PROCESS_STEP_VALUES }).notNull().default("pending"),
        processErrorCode: text("process_error_code").$type<FileProcessErrorCode | null>(),
        tokenCount: integer("token_count").notNull().default(0),
        metadata: text("metadata"),
        loader: text("loader"),
        chunker: text("chunker"),
        chunkSize: integer("chunk_size"),
        documentMode: text("document_mode"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        uniqueIndex("files_graph_checksum_active_unique")
            .on(table.graphId, table.checksum)
            .where(sql`${table.deleted} = false AND ${table.checksum} IS NOT NULL`),
        index("files_name_trgm_idx").using("gin", table.name.op("gin_trgm_ops")),
        index("files_graph_active_created_name_idx")
            .on(table.graphId, table.createdAt, table.name)
            .where(sql`${table.deleted} = false`),
        index("files_graph_active_id_idx")
            .on(table.graphId, table.id)
            .where(sql`${table.deleted} = false`),
        uniqueIndex("files_graph_active_key_idx")
            .on(table.graphId, table.key)
            .where(sql`${table.deleted} = false`),
        check(
            "files_storage_origin_check",
            sql`
                (
                    ${table.storageKind} = 'internal'
                    AND ${table.externalUrl} IS NULL
                    AND ${table.externalProvider} IS NULL
                )
                OR (
                    ${table.storageKind} = 'external'
                    AND ${table.externalUrl} IS NOT NULL
                    AND ${table.externalProvider} IS NOT NULL
                )
            `
        ),
        check(
            "files_external_provider_check",
            sql`${table.externalProvider} IS NULL OR ${table.externalProvider} in ('github', 'gitlab')`
        ),
        index("files_repository_binding_active_idx")
            .on(table.repositoryBindingId, table.createdAt, table.id)
            .where(sql`${table.deleted} = false`),
    ]
);

export const textUnitTable = pgTable.withRLS(
    "text_units",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        fileId: text("file_id")
            .notNull()
            .references(() => filesTable.id, { onDelete: "cascade" }),
        text: text("text").notNull(),
        startPage: integer("start_page"),
        endPage: integer("end_page"),
        chunks: json("chunks")
            .$type<TextUnitSourceChunk[]>()
            .notNull()
            .default(sql`'[]'::json`),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        check(
            "text_units_page_span_check",
            sql`((${table.startPage} IS NULL AND ${table.endPage} IS NULL) OR (${table.startPage} IS NOT NULL AND ${table.endPage} IS NOT NULL AND ${table.startPage} >= 1 AND ${table.endPage} >= ${table.startPage}))`
        ),
        index("text_units_file_idx").on(table.fileId),
    ]
);

export const entityTable = pgTable.withRLS(
    "entities",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        graphId: text("graph_id")
            .notNull()
            .references(() => graphTable.id, { onDelete: "cascade" }),
        active: boolean("active").notNull().default(false),
        name: text("name").notNull(),
        description: text("description").notNull(),
        type: text("type").notNull(),
        embedding: vector("embedding", { dimensions: 4096 }).notNull(),
        searchTsv: tsvector("search_tsv").generatedAlwaysAs(() => weightedTsvectorGenerated(["name", "description"])),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        index("entities_graph_active_idx").on(table.graphId, table.active),
        index("entities_graph_active_id_idx").on(table.graphId, table.active, table.id),
        index("entities_name_trgm_idx").using("gin", table.name.op("gin_trgm_ops")),
        index("entities_embedding_diskann_idx").using("diskann", table.embedding.op("vector_cosine_ops")),
    ]
);

export const relationshipTable = pgTable.withRLS(
    "relationships",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        active: boolean("active").notNull().default(false),
        sourceId: text("source_id")
            .notNull()
            .references(() => entityTable.id, { onDelete: "cascade" }),
        targetId: text("target_id")
            .notNull()
            .references(() => entityTable.id, { onDelete: "cascade" }),
        graphId: text("graph_id")
            .notNull()
            .references(() => graphTable.id, { onDelete: "cascade" }),
        kind: text("kind").notNull().default("RELATED"),
        directed: boolean("directed").notNull().default(false),
        rank: doublePrecision("rank").notNull().default(0),
        description: text("description").notNull(),
        embedding: vector("embedding", { dimensions: 4096 }).notNull(),
        searchTsv: tsvector("search_tsv").generatedAlwaysAs(() => weightedTsvectorGenerated(["description"])),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        index("relationships_graph_active_idx").on(table.graphId, table.active),
        index("relationships_graph_active_id_idx").on(table.graphId, table.active, table.id),
        index("relationships_graph_active_source_id_idx").on(table.graphId, table.active, table.sourceId, table.id),
        index("relationships_graph_active_target_id_idx").on(table.graphId, table.active, table.targetId, table.id),
        index("relationships_description_trgm_idx").using("gin", table.description.op("gin_trgm_ops")),
        index("relationships_embedding_diskann_idx").using("diskann", table.embedding.op("vector_cosine_ops")),
    ]
);

export const sourcesTable = pgTable.withRLS(
    "sources",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        entityId: text("entity_id").references(() => entityTable.id, { onDelete: "cascade" }),
        relationshipId: text("relationship_id").references(() => relationshipTable.id, { onDelete: "cascade" }),
        textUnitId: text("text_unit_id")
            .notNull()
            .references(() => textUnitTable.id, { onDelete: "cascade" }),
        active: boolean("active").notNull().default(false),
        validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" }),
        description: text("description").notNull(),
        sourceChunkIds: json("source_chunk_ids")
            .$type<number[]>()
            .notNull()
            .default(sql`'[]'::json`),
        embedding: vector("embedding", { dimensions: 4096 }).notNull(),
        searchTsv: tsvector("search_tsv").generatedAlwaysAs(() => weightedTsvectorGenerated(["description"])),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        index("sources_active_id_idx").on(table.active, table.id),
        index("sources_entity_active_id_idx").on(table.entityId, table.active, table.id),
        index("sources_relationship_active_id_idx").on(table.relationshipId, table.active, table.id),
        index("sources_current_id_idx")
            .on(table.id)
            .where(sql`${table.active} = true AND ${table.validUntil} IS NULL`),
        index("sources_entity_current_id_idx")
            .on(table.entityId, table.id)
            .where(sql`${table.active} = true AND ${table.validUntil} IS NULL AND ${table.entityId} IS NOT NULL`),
        index("sources_relationship_current_id_idx")
            .on(table.relationshipId, table.id)
            .where(sql`${table.active} = true AND ${table.validUntil} IS NULL AND ${table.relationshipId} IS NOT NULL`),
        index("sources_text_unit_idx").on(table.textUnitId),
        index("sources_description_trgm_idx").using("gin", table.description.op("gin_trgm_ops")),
        index("sources_embedding_diskann_idx").using("diskann", table.embedding.op("vector_cosine_ops")),
    ]
);

export const processStatsTable = pgTable.withRLS("process_stats", {
    id: text("id")
        .primaryKey()
        .$default(() => ulid()),
    totalTime: doublePrecision("total_time").notNull().default(0),
    files: integer("files").notNull().default(0),
    fileSizes: doublePrecision("file_sizes").notNull().default(0),
    fileType: text("file_type").notNull().default("unknown"),
    tokenCount: integer("token_count").notNull().default(0),
});

export const processRunsTable = pgTable.withRLS(
    "process_runs",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        graphId: text("graph_id")
            .notNull()
            .references(() => graphTable.id, { onDelete: "cascade" }),
        status: text("status", { enum: PROCESS_RUN_STATUS_VALUES }).notNull().default("pending"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
        completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [index("process_runs_graph_status_created_idx").on(table.graphId, table.status, table.createdAt)]
);

export const processRunFilesTable = pgTable.withRLS(
    "process_run_files",
    {
        processRunId: text("process_run_id")
            .notNull()
            .references(() => processRunsTable.id, { onDelete: "cascade" }),
        fileId: text("file_id")
            .notNull()
            .references(() => filesTable.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    },
    (table) => [
        primaryKey({ name: "process_run_files_pk", columns: [table.processRunId, table.fileId] }),
        index("process_run_files_file_idx").on(table.fileId),
    ]
);
