import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import { organizationTable } from "./auth";

export const fileTypeConfigsTable = pgTable.withRLS(
    "file_type_configs",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organizationTable.id, { onDelete: "cascade" }),
        fileType: text("file_type").notNull(),
        loader: text("loader").notNull(),
        chunker: text("chunker").notNull(),
        chunkSize: integer("chunk_size"),
        documentMode: text("document_mode"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [uniqueIndex("file_type_configs_organization_file_type_unique").on(table.organizationId, table.fileType)]
);

export type FileTypeConfig = typeof fileTypeConfigsTable.$inferSelect;
export type NewFileTypeConfig = typeof fileTypeConfigsTable.$inferInsert;
