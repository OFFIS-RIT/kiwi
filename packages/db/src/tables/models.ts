import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import { organizationTable } from "./auth";

export const AI_MODEL_TYPE_VALUES = ["text", "subagent", "extract", "embedding", "image", "audio", "video"] as const;
export type AiModelType = (typeof AI_MODEL_TYPE_VALUES)[number];

export const AI_MODEL_ADAPTER_VALUES = ["openai", "azure", "anthropic", "openaiAPI"] as const;
export type AiModelAdapter = (typeof AI_MODEL_ADAPTER_VALUES)[number];

export const modelsTable = pgTable.withRLS(
    "models",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organizationTable.id, { onDelete: "cascade" }),
        modelId: text("model_id").notNull(),
        displayName: text("display_name").notNull(),
        type: text("type", { enum: AI_MODEL_TYPE_VALUES }).notNull(),
        adapter: text("adapter", { enum: AI_MODEL_ADAPTER_VALUES }).notNull(),
        providerModel: text("provider_model").notNull(),
        encryptedCredentials: text("encrypted_credentials").notNull(),
        isDefault: boolean("is_default").notNull().default(false),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        uniqueIndex("models_organization_model_id_unique").on(table.organizationId, table.modelId),
        uniqueIndex("models_organization_type_default_unique")
            .on(table.organizationId, table.type)
            .where(sql`${table.isDefault} = true`),
        index("models_organization_type_idx").on(table.organizationId, table.type),
    ]
);

export type AiModel = typeof modelsTable.$inferSelect;
export type NewAiModel = typeof modelsTable.$inferInsert;
