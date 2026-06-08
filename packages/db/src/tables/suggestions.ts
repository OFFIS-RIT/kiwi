import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import { userTable } from "./auth";
import { chatTable, messageTable } from "./chats";
import { entityTable, graphTable, sourcesTable } from "./graph";

export const GRAPH_SUGGESTION_KIND_VALUES = ["source_correction", "entity_addition"] as const;
export type GraphSuggestionKind = (typeof GRAPH_SUGGESTION_KIND_VALUES)[number];

export const GRAPH_SUGGESTION_STATUS_VALUES = ["pending", "applied"] as const;
export type GraphSuggestionStatus = (typeof GRAPH_SUGGESTION_STATUS_VALUES)[number];

export const graphSuggestionsTable = pgTable.withRLS(
    "graph_suggestions",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        graphId: text("graph_id")
            .notNull()
            .references(() => graphTable.id, { onDelete: "cascade" }),
        kind: text("kind", { enum: GRAPH_SUGGESTION_KIND_VALUES }).notNull(),
        status: text("status", { enum: GRAPH_SUGGESTION_STATUS_VALUES }).notNull().default("pending"),
        sourceId: text("source_id").references(() => sourcesTable.id, { onDelete: "cascade" }),
        entityId: text("entity_id").references(() => entityTable.id, { onDelete: "cascade" }),
        reference: text("reference").notNull(),
        suggestion: text("suggestion").notNull(),
        suggestedByUserId: text("suggested_by_user_id")
            .notNull()
            .references(() => userTable.id, { onDelete: "cascade" }),
        chatId: text("chat_id").references(() => chatTable.id, { onDelete: "set null" }),
        messageId: text("message_id").references(() => messageTable.id, { onDelete: "set null" }),
        appliedByUserId: text("applied_by_user_id").references(() => userTable.id, { onDelete: "set null" }),
        appliedSourceId: text("applied_source_id").references(() => sourcesTable.id, { onDelete: "set null" }),
        appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        check(
            "graph_suggestions_target_check",
            sql`
                (
                    ${table.kind} = 'source_correction'
                    AND ${table.sourceId} IS NOT NULL
                    AND ${table.entityId} IS NULL
                )
                OR
                (
                    ${table.kind} = 'entity_addition'
                    AND ${table.sourceId} IS NULL
                    AND ${table.entityId} IS NOT NULL
                )
            `
        ),
        index("graph_suggestions_graph_status_created_idx").on(
            table.graphId,
            table.status,
            table.createdAt,
            table.id
        ),
        index("graph_suggestions_source_idx").on(table.sourceId),
        index("graph_suggestions_entity_idx").on(table.entityId),
    ]
);

export type GraphSuggestion = typeof graphSuggestionsTable.$inferSelect;
