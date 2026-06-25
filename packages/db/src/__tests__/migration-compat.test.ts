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
const codeGraphMigration = new URL(
    "../../../../migrations/20260613184716_sturdy_triton/migration.sql",
    import.meta.url
);
const codeGraphSnapshot = new URL("../../../../migrations/20260613184716_sturdy_triton/snapshot.json", import.meta.url);
const externalFileStorageMigration = new URL(
    "../../../../migrations/20260613201908_mature_emma_frost/migration.sql",
    import.meta.url
);
const externalFileStorageSnapshot = new URL(
    "../../../../migrations/20260613201908_mature_emma_frost/snapshot.json",
    import.meta.url
);
const sourceValidityMigration = new URL(
    "../../../../migrations/20260614105716_tricky_plazm/migration.sql",
    import.meta.url
);
const sourceValiditySnapshot = new URL(
    "../../../../migrations/20260614105716_tricky_plazm/snapshot.json",
    import.meta.url
);
const saveGraphModule = new URL("../../../../apps/worker/lib/graph/save.ts", import.meta.url);
const regenerateDescriptionsModule = new URL("../../../../apps/worker/lib/descriptions/regenerate.ts", import.meta.url);
const sourceReferenceModule = new URL("../../../../apps/api/src/lib/source-reference.ts", import.meta.url);

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

describe("code graph migration compatibility", () => {
    test("adds directed relationship metadata and seeds code file type configs idempotently", async () => {
        const sql = await Bun.file(codeGraphMigration).text();

        expect(sql).toContain("ADD COLUMN IF NOT EXISTS \"kind\" text DEFAULT 'RELATED' NOT NULL");
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS "directed" boolean DEFAULT false NOT NULL');
        expect(sql).toContain("'code'");
        expect(sql).toContain("'text'");
        expect(sql).toContain("'semantic'");
        expect(sql).toContain('ON CONFLICT ("organization_id", "file_type") DO NOTHING');
    });

    test("keeps relationship metadata columns in the migration snapshot", async () => {
        const snapshot = (await Bun.file(codeGraphSnapshot).json()) as {
            ddl: Array<Record<string, unknown>>;
        };
        const relationshipColumns = snapshot.ddl.filter(
            (entry) => entry.entityType === "columns" && entry.table === "relationships"
        );

        expect(relationshipColumns).toContainEqual(
            expect.objectContaining({
                name: "kind",
                type: "text",
                notNull: true,
                default: "'RELATED'",
            })
        );
        expect(relationshipColumns).toContainEqual(
            expect.objectContaining({
                name: "directed",
                type: "boolean",
                notNull: true,
                default: "false",
            })
        );
    });
});

describe("external file storage migration compatibility", () => {
    test("adds explicit storage origin columns and constraints", async () => {
        const sql = await Bun.file(externalFileStorageMigration).text();

        expect(sql).toContain("ADD COLUMN \"storage_kind\" text DEFAULT 'internal' NOT NULL");
        expect(sql).toContain('ADD COLUMN "external_url" text');
        expect(sql).toContain('ADD COLUMN "external_provider" text');
        expect(sql).toContain('ADD CONSTRAINT "files_storage_origin_check"');
        expect(sql).toContain(`"storage_kind" = 'internal'`);
        expect(sql).toContain(`"storage_kind" = 'external'`);
        expect(sql).toContain('ADD CONSTRAINT "files_external_provider_check"');
        expect(sql).toContain(`"external_provider" IS NULL OR "external_provider" = 'github'`);
    });

    test("keeps external storage columns in the migration snapshot", async () => {
        const snapshot = (await Bun.file(externalFileStorageSnapshot).json()) as {
            ddl: Array<Record<string, unknown>>;
        };
        const fileColumns = snapshot.ddl.filter((entry) => entry.entityType === "columns" && entry.table === "files");
        const fileChecks = snapshot.ddl.filter((entry) => entry.entityType === "checks" && entry.table === "files");

        expect(fileColumns).toContainEqual(
            expect.objectContaining({
                name: "storage_kind",
                type: "text",
                notNull: true,
                default: "'internal'",
            })
        );
        expect(fileColumns).toContainEqual(expect.objectContaining({ name: "external_url", type: "text" }));
        expect(fileColumns).toContainEqual(expect.objectContaining({ name: "external_provider", type: "text" }));
        expect(fileChecks).toContainEqual(expect.objectContaining({ name: "files_storage_origin_check" }));
        expect(fileChecks).toContainEqual(expect.objectContaining({ name: "files_external_provider_check" }));
    });
});

describe("source validity migration compatibility", () => {
    test("adds source validity without deleting historical sources", async () => {
        const sql = await Bun.file(sourceValidityMigration).text();

        expect(sql).toContain('ADD COLUMN IF NOT EXISTS "valid_until" timestamp with time zone');
        expect(sql).toContain('"active" = true AND "valid_until" IS NULL');
        expect(sql).toContain('CREATE INDEX IF NOT EXISTS "sources_current_id_idx"');
        expect(sql).toContain('CREATE INDEX IF NOT EXISTS "sources_entity_current_id_idx"');
        expect(sql).toContain('CREATE INDEX IF NOT EXISTS "sources_relationship_current_id_idx"');
        expect(sql).not.toMatch(/DELETE\s+FROM\s+"sources"/i);
    });

    test("keeps valid_until, connector tables, and indexes in the migration snapshot", async () => {
        const snapshot = (await Bun.file(sourceValiditySnapshot).json()) as {
            ddl: Array<Record<string, unknown>>;
        };
        const sourceColumns = snapshot.ddl.filter(
            (entry) => entry.entityType === "columns" && entry.table === "sources"
        );
        const sourceIndexes = snapshot.ddl.filter(
            (entry) => entry.entityType === "indexes" && entry.table === "sources"
        );
        const connectorTables = snapshot.ddl.filter((entry) => entry.entityType === "tables");
        const connectorColumns = snapshot.ddl.filter((entry) => entry.entityType === "columns");
        const connectorIndexes = snapshot.ddl.filter((entry) => entry.entityType === "indexes");
        const connectorChecks = snapshot.ddl.filter((entry) => entry.entityType === "checks");
        const connectorFks = snapshot.ddl.filter((entry) => entry.entityType === "fks");

        expect(sourceColumns).toContainEqual(
            expect.objectContaining({
                name: "valid_until",
                type: "timestamp with time zone",
                notNull: false,
            })
        );
        expect(sourceIndexes).toContainEqual(
            expect.objectContaining({
                name: "sources_current_id_idx",
                where: '"active" = true AND "valid_until" IS NULL',
            })
        );
        expect(sourceIndexes).toContainEqual(expect.objectContaining({ name: "sources_entity_current_id_idx" }));
        expect(sourceIndexes).toContainEqual(expect.objectContaining({ name: "sources_relationship_current_id_idx" }));
        expect(connectorTables).toContainEqual(expect.objectContaining({ name: "connectors" }));
        expect(connectorTables).toContainEqual(expect.objectContaining({ name: "connector_installations" }));
        expect(connectorTables).toContainEqual(expect.objectContaining({ name: "repository_graph_bindings" }));
        expect(connectorTables).toContainEqual(expect.objectContaining({ name: "connector_webhook_events" }));
        expect(connectorColumns).toContainEqual(
            expect.objectContaining({ table: "files", name: "repository_binding_id", type: "text" })
        );
        expect(connectorColumns).toContainEqual(
            expect.objectContaining({ table: "connectors", name: "encrypted_credentials", notNull: true })
        );
        expect(connectorColumns).toContainEqual(
            expect.objectContaining({ table: "repository_graph_bindings", name: "sync_status", default: "'pending'" })
        );
        expect(connectorIndexes).toContainEqual(expect.objectContaining({ name: "connectors_provider_status_idx" }));
        expect(connectorIndexes).toContainEqual(
            expect.objectContaining({
                name: "connector_installations_org_scope_unique",
                isUnique: true,
                where: '"team_id" IS NULL',
            })
        );
        expect(connectorIndexes).toContainEqual(
            expect.objectContaining({
                name: "connector_installations_team_scope_unique",
                isUnique: true,
                where: '"team_id" IS NOT NULL',
            })
        );
        expect(connectorIndexes).toContainEqual(
            expect.objectContaining({ name: "repository_graph_bindings_graph_unique", isUnique: true })
        );
        expect(connectorIndexes).toContainEqual(
            expect.objectContaining({ name: "connector_webhook_events_delivery_unique", isUnique: true })
        );
        expect(connectorIndexes).toContainEqual(
            expect.objectContaining({ name: "files_repository_binding_active_idx" })
        );
        expect(connectorChecks).toContainEqual(expect.objectContaining({ name: "connectors_provider_check" }));
        expect(connectorChecks).toContainEqual(
            expect.objectContaining({ name: "repository_graph_bindings_sync_status_check" })
        );
        expect(connectorFks).toContainEqual(
            expect.objectContaining({
                name: "files_repository_binding_id_repository_graph_bindings_id_fk",
                table: "files",
                tableTo: "repository_graph_bindings",
            })
        );
    });

    test("adds connector tables and idempotent indexes to the migration sql", async () => {
        const sql = await Bun.file(sourceValidityMigration).text();

        expect(sql).toContain('CREATE TABLE IF NOT EXISTS "connectors"');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS "connector_installations"');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS "repository_graph_bindings"');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS "connector_webhook_events"');
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS "repository_binding_id" text');
        expect(sql).toContain('ADD CONSTRAINT "files_repository_binding_id_repository_graph_bindings_id_fk"');
        expect(sql).not.toContain('CONSTRAINT "connector_installations_provider_scope_unique"');
        expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "connector_installations_org_scope_unique"');
        expect(sql).toContain('WHERE "team_id" IS NULL');
        expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "connector_installations_team_scope_unique"');
        expect(sql).toContain('WHERE "team_id" IS NOT NULL');
        expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "connector_webhook_events_delivery_unique"');
        expect(sql).toContain("\"external_provider\" IS NULL OR \"external_provider\" in ('github', 'gitlab')");
    });
    test("invalidates older code sources instead of deleting them", async () => {
        const source = await Bun.file(saveGraphModule).text();

        expect(source).toContain("SET valid_until = NOW()");
        expect(source).toContain("old_file.file_type = 'code'");
        expect(source).toContain('currentSourceSql("old_source")');
        expect(source).not.toMatch(/DELETE\s+FROM\s+sources\s+source/i);
    });

    test("filters user-facing source references to current visible sources", async () => {
        const source = await Bun.file(sourceReferenceModule).text();

        expect(source).toContain("currentSourcePredicate(sourcesTable)");
        expect(source).toContain("visibleFilePredicate(filesTable)");
    });

    test("deactivates descriptions with no unexpired visible sources", async () => {
        const source = await Bun.file(regenerateDescriptionsModule).text();

        expect(source).toContain("unexpiredSourcePredicate(sourcesTable)");
        expect(source).toContain("visibleFilePredicate(filesTable)");
        expect(source).toContain("SET active = false");
        expect(source).toContain("AND source.valid_until IS NULL");
    });
});
