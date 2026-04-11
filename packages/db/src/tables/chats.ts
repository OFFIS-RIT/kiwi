import { sql } from "drizzle-orm";
import { check, doublePrecision, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import { userTable } from "./auth";
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
        graphId: text("project_id").references(() => graphTable.id, { onDelete: "cascade" }),
        title: text("title").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [index("idx_user_chats_user_project_updated_at").on(table.userId, table.graphId, table.updatedAt.desc())]
);

export type MessageTextPart = {
    type: "text";
    text: string;
};

export type MessageReasoningPart = {
    type: "reasoning";
    text: string;
};

export type MessageToolPart = {
    type: "tool";
    toolCallId: string;
    toolName: string;
    execution: "server" | "client";
    status: "pending" | "completed" | "failed";
    // oxlint-disable-next-line no-explicit-any -- fine here args can be anything
    args: any;
    // oxlint-disable-next-line no-explicit-any -- fine here execution can be anything
    result?: any;
};

export type MessageCitationPart = {
    type: "citation";
    citation: {
        id: string;
        sourceId: string;
        textUnitId: string;
        fileId: string;
        fileName: string;
        fileKey: string;
        excerpt?: string;
        description?: string;
    };
};

export type MessageMetadataPart = {
    type: "metadata";
    metadata: {
        createdAt?: string;
        modelId?: string;
        totalTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
        tokensPerSecond?: number;
        timeToFirstToken?: number;
        durationMs?: number;
        consideredFileCount?: number;
        usedFileCount?: number;
    };
};

export type MessagePart =
    | MessageTextPart
    | MessageReasoningPart
    | MessageToolPart
    | MessageCitationPart
    | MessageMetadataPart;

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
        parts: jsonb("parts").$type<MessagePart[]>().notNull(),
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
