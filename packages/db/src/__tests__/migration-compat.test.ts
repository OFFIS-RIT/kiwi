import { describe, expect, test } from "bun:test";

const sourceReferenceMigration = new URL(
    "../../../../migrations/20260530145140_abnormal_jubilee/migration.sql",
    import.meta.url
);
const teamChatMigration = new URL(
    "../../../../migrations/20260604133037_quick_bullseye/migration.sql",
    import.meta.url
);
const jsonFileTypeMigration = new URL(
    "../../../../migrations/20260613080110_public_piledriver/migration.sql",
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

describe("json file type migration compatibility", () => {
    test("seeds jsonl and jsonc file type configs idempotently", async () => {
        const sql = await Bun.file(jsonFileTypeMigration).text();

        expect(sql).toContain("('jsonl', 'json', 'json', 500, NULL)");
        expect(sql).toContain("('jsonc', 'json', 'json', 500, NULL)");
        expect(sql).toContain('ON CONFLICT ("organization_id", "file_type") DO NOTHING');
    });
});
