ALTER TABLE "connector_installations" ADD COLUMN "subject_kind" text;
ALTER TABLE "connector_installations" ADD COLUMN "subject_user_id" text;
ALTER TABLE "connector_installations" ADD COLUMN "subject_team_id" text;
ALTER TABLE "connector_installations" ADD COLUMN "subject_organization_id" text;

UPDATE "connector_installations"
SET
    "subject_kind" = CASE WHEN "team_id" IS NOT NULL THEN 'team' ELSE 'organization' END,
    "subject_team_id" = CASE WHEN "team_id" IS NOT NULL THEN "team_id" ELSE NULL END,
    "subject_organization_id" = CASE WHEN "team_id" IS NULL THEN "organization_id" ELSE NULL END
WHERE "subject_kind" IS NULL;

ALTER TABLE "connector_installations" ALTER COLUMN "subject_kind" SET NOT NULL;

ALTER TABLE "connector_installations" DROP CONSTRAINT IF EXISTS "connector_installations_owner_scope_check";
ALTER TABLE "connector_installations" DROP CONSTRAINT IF EXISTS "connector_installations_status_check";
DROP INDEX IF EXISTS "connector_installations_org_scope_unique";
DROP INDEX IF EXISTS "connector_installations_team_scope_unique";

ALTER TABLE "connector_installations"
    ADD CONSTRAINT "connector_installations_subject_user_id_user_id_fk"
    FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "connector_installations"
    ADD CONSTRAINT "connector_installations_subject_team_id_team_id_fk"
    FOREIGN KEY ("subject_team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "connector_installations"
    ADD CONSTRAINT "connector_installations_subject_organization_id_organization_id_fk"
    FOREIGN KEY ("subject_organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "connector_installations_user_subject_unique"
    ON "connector_installations" USING btree ("connector_id", "provider_installation_id", "subject_user_id")
    WHERE "connector_installations"."subject_kind" = 'user';
CREATE UNIQUE INDEX "connector_installations_team_subject_unique"
    ON "connector_installations" USING btree ("connector_id", "provider_installation_id", "subject_team_id")
    WHERE "connector_installations"."subject_kind" = 'team';
CREATE UNIQUE INDEX "connector_installations_organization_subject_unique"
    ON "connector_installations" USING btree ("connector_id", "provider_installation_id", "subject_organization_id")
    WHERE "connector_installations"."subject_kind" = 'organization';
CREATE INDEX "connector_installations_subject_user_idx" ON "connector_installations" USING btree ("subject_user_id");
CREATE INDEX "connector_installations_subject_team_idx" ON "connector_installations" USING btree ("subject_team_id");
CREATE INDEX "connector_installations_subject_organization_idx" ON "connector_installations" USING btree ("subject_organization_id");
CREATE INDEX "connector_installations_installed_by_user_idx" ON "connector_installations" USING btree ("installed_by_user_id");

ALTER TABLE "connector_installations"
    ADD CONSTRAINT "connector_installations_status_check"
    CHECK ("status" in ('active', 'disabled', 'pending'));
ALTER TABLE "connector_installations"
    ADD CONSTRAINT "connector_installations_subject_kind_check"
    CHECK ("subject_kind" in ('user', 'team', 'organization'));
ALTER TABLE "connector_installations"
    ADD CONSTRAINT "connector_installations_subject_scope_check"
    CHECK (
        ("subject_kind" = 'user' and "subject_user_id" is not null and "subject_team_id" is null and "subject_organization_id" is null)
        or ("subject_kind" = 'team' and "subject_user_id" is null and "subject_team_id" is not null and "subject_organization_id" is null)
        or ("subject_kind" = 'organization' and "subject_user_id" is null and "subject_team_id" is null and "subject_organization_id" is not null)
    );

ALTER TABLE "connector_resource_bindings" ADD COLUMN "sync_enabled" boolean DEFAULT true NOT NULL;
ALTER TABLE "connector_resource_bindings" ALTER COLUMN "resource_kind" DROP DEFAULT;
ALTER TABLE "connector_resource_bindings" ALTER COLUMN "version_name" DROP NOT NULL;
DROP INDEX IF EXISTS "connector_resource_bindings_resource_version_unique";
CREATE UNIQUE INDEX "connector_resource_bindings_resource_version_unique"
    ON "connector_resource_bindings" USING btree ("connector_installation_id", "provider_resource_id", "version_name")
    WHERE "connector_resource_bindings"."version_name" IS NOT NULL;
CREATE UNIQUE INDEX "connector_resource_bindings_resource_unique"
    ON "connector_resource_bindings" USING btree ("connector_installation_id", "provider_resource_id")
    WHERE "connector_resource_bindings"."version_name" IS NULL;