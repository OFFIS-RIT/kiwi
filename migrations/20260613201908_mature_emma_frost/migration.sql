ALTER TABLE "files" ADD COLUMN "storage_kind" text DEFAULT 'internal' NOT NULL;
ALTER TABLE "files" ADD COLUMN "external_url" text;
ALTER TABLE "files" ADD COLUMN "external_provider" text;

ALTER TABLE "files" ADD CONSTRAINT "files_storage_origin_check" CHECK (
    (
        "storage_kind" = 'internal'
        AND "external_url" IS NULL
        AND "external_provider" IS NULL
    )
    OR (
        "storage_kind" = 'external'
        AND "external_url" IS NOT NULL
        AND "external_provider" IS NOT NULL
    )
);

ALTER TABLE "files" ADD CONSTRAINT "files_external_provider_check" CHECK (
    "external_provider" IS NULL OR "external_provider" = 'github'
);