import { describe, expect, test } from "bun:test";

const sourceReferenceMigration = new URL(
    "../../../../migrations/20260530145140_abnormal_jubilee/migration.sql",
    import.meta.url
);
const teamChatMigration = new URL(
    "../../../../migrations/20260604133037_quick_bullseye/migration.sql",
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

describe("team chat migration compatibility", () => {
    test("adds an explicit chat scope discriminator and target check", async () => {
        const sql = await Bun.file(teamChatMigration).text();

        expect(sql).toContain("ADD COLUMN \"scope\" text DEFAULT 'graph' NOT NULL");
        expect(sql).toContain('ADD COLUMN "team_id" text');
        expect(sql).toContain('ADD CONSTRAINT "chats_scope_target_check"');
        expect(sql).toContain(`"scope" = 'graph' AND "project_id" IS NOT NULL AND "team_id" IS NULL`);
        expect(sql).toContain(`"scope" = 'team' AND "project_id" IS NULL AND "team_id" IS NOT NULL`);
    });
});
