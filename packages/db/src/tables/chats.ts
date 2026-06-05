import { sql } from "drizzle-orm";
import { check, doublePrecision, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import type { MessagePart as StoredMessagePart } from "@kiwi/contracts/chat";
import { teamTable, userTable } from "./auth";
import { graphTable } from "./graph";

export const chatTable = pgTable.withRLS(
    "chats",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        userId: text("user_id")
            .notNull()
            .references(() => userTable.id, { onDelete: "cascade" }),
        scope: text("scope", { enum: ["graph", "team"] })
            .notNull()
            .default("graph"),
        graphId: text("project_id").references(() => graphTable.id, { onDelete: "cascade" }),
        teamId: text("team_id").references(() => teamTable.id, { onDelete: "cascade" }),
        title: text("title").notNull(),
        pinnedAt: timestamp("pinned_at", { withTimezone: true, mode: "date" }),
        archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        check(
            "chats_scope_target_check",
            sql`
                (
                    ${table.scope} = 'graph'
                    AND ${table.graphId} IS NOT NULL
                    AND ${table.teamId} IS NULL
                )
                OR
                (
                    ${table.scope} = 'team'
                    AND ${table.graphId} IS NULL
                    AND ${table.teamId} IS NOT NULL
                )
            `
        ),
        index("idx_user_chats_user_project_updated_at").on(table.userId, table.graphId, table.updatedAt.desc()),
        index("idx_user_chats_user_team_updated_at").on(table.userId, table.teamId, table.updatedAt.desc()),
        index("idx_user_chats_user_project_archived_updated_at")
            .on(table.userId, table.graphId, sql`(${table.pinnedAt} is null)`, table.updatedAt.desc(), table.id.desc())
            .where(sql`${table.archivedAt} IS NULL`),
        index("idx_user_chats_user_team_archived_updated_at")
            .on(table.userId, table.teamId, sql`(${table.pinnedAt} is null)`, table.updatedAt.desc(), table.id.desc())
            .where(sql`${table.archivedAt} IS NULL`),
        index("chats_title_trgm_idx").using("gin", table.title.op("gin_trgm_ops")),
    ]
);

export type {
    MessageCompactionPart,
    MessageMetadataPart,
    MessagePart,
    MessageReasoningPart,
    MessageTextPart,
    MessageToolPart,
} from "@kiwi/contracts/chat";

export const messageTable = pgTable.withRLS(
    "messages",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        chatId: text("chat_id")
            .notNull()
            .references(() => chatTable.id, { onDelete: "cascade" }),
        status: text("status", { enum: ["pending", "completed", "failed", "canceled"] })
            .notNull()
            .default("pending"),
        role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
        parts: jsonb("parts").$type<StoredMessagePart[]>().notNull(),
        tokensPerSecond: doublePrecision("tokens_per_second"),
        timeToFirstToken: doublePrecision("time_to_first_token"),
        inputTokens: doublePrecision("input_tokens"),
        outputTokens: doublePrecision("output_tokens"),
        totalTokens: doublePrecision("total_tokens"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        check("chat_messages_parts_array_check", sql`jsonb_typeof(${table.parts}) = 'array'`),
        index("idx_chat_messages_chat_id_id").on(table.chatId, table.createdAt, table.id),
        index("idx_chat_messages_chat_role_status_id").on(
            table.chatId,
            table.role,
            table.status,
            table.createdAt,
            table.id
        ),
    ]
);

export type ChatMessage = typeof messageTable.$inferSelect;
