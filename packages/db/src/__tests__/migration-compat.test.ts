import { describe, expect, test } from "bun:test";

const sourceReferenceMigration = new URL(
    "../../../../migrations/20260530145140_abnormal_jubilee/migration.sql",
    import.meta.url
);

describe("source reference migration compatibility", () => {
    test("uses an expand-only migration for source chunk backfill", async () => {
        const sql = await Bun.file(sourceReferenceMigration).text();

        expect(sql).toContain('ADD COLUMN "chunks" json DEFAULT');
        expect(sql).toContain('ADD COLUMN "source_chunk_ids" json DEFAULT');
        expect(sql).toContain("json_build_array");
        expect(sql).toContain('"f"."file_type" <> \'pdf\'');
        expect(sql).not.toMatch(/DROP\s+COLUMN[^;]*"evidence_sentences"/i);
    });
});
