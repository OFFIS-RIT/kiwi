import { sql } from "drizzle-orm";
import {
    boolean,
    check,
    doublePrecision,
    index,
    integer,
    json,
    pgTable,
    primaryKey,
    text,
    timestamp,
    vector,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import { userTable } from "./auth";
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

export const groupTable = pgTable.withRLS("groups", {
    id: text("id")
        .primaryKey()
        .$default(() => ulid()),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
});

export const groupUserTable = pgTable.withRLS(
    "group_users",
    {
        groupId: text("group_id")
            .notNull()
            .references(() => groupTable.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => userTable.id, { onDelete: "cascade" }),
        role: text("role", { enum: ["user", "admin", "moderator"] })
            .notNull()
            .default("user"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        {
            primaryKey: primaryKey({ name: "group_users_pk", columns: [table.groupId, table.userId] }),
        },
    ]
);

export const graphTable = pgTable.withRLS(
    "graphs",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        groupId: text("group_id").references(() => groupTable.id, { onDelete: "cascade" }),
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
            sql`(((${table.groupId} IS NOT NULL)::int + (${table.userId} IS NOT NULL)::int + (${table.graphId} IS NOT NULL)::int) <= 1)`
        ),
        index("graphs_group_type_idx").on(table.groupId, table.type),
        index("graphs_user_type_idx").on(table.userId, table.type),
        index("graphs_graph_type_idx").on(table.graphId, table.type),
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

export const systemPromptsTable = pgTable.withRLS("system_prompts", {
    id: text("id")
        .primaryKey()
        .$default(() => ulid()),
    graphId: text("graph_id")
        .notNull()
        .references(() => graphTable.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
});

export const filesTable = pgTable.withRLS("files", {
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
    deleted: boolean("deleted").default(false),
    status: text("status", { enum: FILE_PROCESS_STATUS_VALUES }).notNull().default("processing"),
    processStep: text("process_step", { enum: FILE_PROCESS_STEP_VALUES }).notNull().default("pending"),
    tokenCount: integer("token_count").notNull().default(0),
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
});

export const textUnitTable = pgTable.withRLS("text_units", {
    id: text("id")
        .primaryKey()
        .$default(() => ulid()),
    fileId: text("file_id")
        .notNull()
        .references(() => filesTable.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
});

export const entityTable = pgTable.withRLS("entities", {
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
});

export const relationshipTable = pgTable.withRLS("relationships", {
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
    rank: doublePrecision("rank").notNull().default(0),
    description: text("description").notNull(),
    embedding: vector("embedding", { dimensions: 4096 }).notNull(),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(() => weightedTsvectorGenerated(["description"])),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
});

export const sourcesTable = pgTable.withRLS("sources", {
    id: text("id")
        .primaryKey()
        .$default(() => ulid()),
    entityId: text("entity_id").references(() => entityTable.id, { onDelete: "cascade" }),
    relationshipId: text("relationship_id").references(() => relationshipTable.id, { onDelete: "cascade" }),
    textUnitId: text("text_unit_id")
        .notNull()
        .references(() => textUnitTable.id, { onDelete: "cascade" }),
    active: boolean("active").notNull().default(false),
    description: text("description").notNull(),
    embedding: vector("embedding", { dimensions: 4096 }).notNull(),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(() => weightedTsvectorGenerated(["description"])),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
});

export const processStatsTable = pgTable.withRLS("process_stats", {
    id: text("id")
        .primaryKey()
        .$default(() => ulid()),
    totalTime: doublePrecision("total_time").notNull().default(0),
    files: integer("files").notNull().default(0),
    fileSizes: doublePrecision("file_sizes").notNull().default(0),
    tokenCount: integer("token_count").notNull().default(0),
});
