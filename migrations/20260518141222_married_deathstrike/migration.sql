CREATE TABLE "organization" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"logo" text,
	"metadata" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "team" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "team" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY,
	"organizationId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"systemRoleProvisioned" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "teamMember" (
	"id" text PRIMARY KEY,
	"teamId" text NOT NULL,
	"userId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "teamMember" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "team_member_roles" (
	"team_member_id" text PRIMARY KEY,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY,
	"organizationId" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"teamId" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"inviterId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "member_organization_user_unique" ON "member" ("organizationId", "userId");
--> statement-breakpoint
CREATE UNIQUE INDEX "team_member_team_user_unique" ON "teamMember" ("teamId", "userId");
--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_id_organization_unique" UNIQUE ("id", "organizationId");
--> statement-breakpoint
INSERT INTO "organization" ("id", "name", "slug", "createdAt")
SELECT 'default', 'Default Org', 'default-org', now()
WHERE NOT EXISTS (SELECT 1 FROM "organization");
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "activeOrganizationId" text;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "activeTeamId" text;
--> statement-breakpoint
ALTER TABLE "graphs" ADD COLUMN "organization_id" text;
--> statement-breakpoint
ALTER TABLE "graphs" ADD COLUMN "team_id" text;
--> statement-breakpoint
INSERT INTO "team" ("id", "name", "organizationId", "createdAt", "updatedAt")
SELECT
	"groups"."id",
	"groups"."name",
	'default',
	COALESCE("groups"."created_at", now()),
	"groups"."updated_at"
FROM "groups"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "member" ("id", "organizationId", "userId", "role", "systemRoleProvisioned", "createdAt")
SELECT
	'org_member_' || "user"."id",
	'default',
	"user"."id",
	CASE
		WHEN 'admin' = ANY(regexp_split_to_array(btrim(COALESCE("user"."role", '')), '[[:space:]]*,[[:space:]]*')) THEN 'admin'
		ELSE 'member'
	END,
	'admin' = ANY(regexp_split_to_array(btrim(COALESCE("user"."role", '')), '[[:space:]]*,[[:space:]]*')),
	COALESCE("user"."createdAt", now())
FROM "user"
ON CONFLICT ("organizationId", "userId") DO UPDATE SET
	"role" = CASE
		WHEN "member"."role" = 'admin' OR EXCLUDED."role" = 'admin' THEN 'admin'
		ELSE 'member'
	END,
	"systemRoleProvisioned" = "member"."systemRoleProvisioned" OR EXCLUDED."systemRoleProvisioned";
--> statement-breakpoint
WITH grouped_members AS (
	SELECT
		"group_users"."group_id",
		"group_users"."user_id",
		min("group_users"."created_at") AS "created_at"
	FROM "group_users"
	GROUP BY "group_users"."group_id", "group_users"."user_id"
)
INSERT INTO "teamMember" ("id", "teamId", "userId", "createdAt")
SELECT
	'team_member_' || grouped_members."group_id" || '_' || grouped_members."user_id",
	grouped_members."group_id",
	grouped_members."user_id",
	COALESCE(grouped_members."created_at", now())
FROM grouped_members
ON CONFLICT ("teamId", "userId") DO NOTHING;
--> statement-breakpoint
WITH grouped_roles AS (
	SELECT
		"group_users"."group_id",
		"group_users"."user_id",
		min(
			CASE "group_users"."role"
				WHEN 'admin' THEN 1
				WHEN 'moderator' THEN 2
				ELSE 3
			END
		) AS "rank",
		min("group_users"."created_at") AS "created_at",
		max("group_users"."updated_at") AS "updated_at"
	FROM "group_users"
	GROUP BY "group_users"."group_id", "group_users"."user_id"
)
INSERT INTO "team_member_roles" ("team_member_id", "role", "created_at", "updated_at")
SELECT
	"teamMember"."id",
	CASE grouped_roles."rank"
		WHEN 1 THEN 'admin'
		WHEN 2 THEN 'moderator'
		ELSE 'member'
	END,
	COALESCE(grouped_roles."created_at", now()),
	COALESCE(grouped_roles."updated_at", now())
FROM grouped_roles
INNER JOIN "teamMember"
	ON "teamMember"."teamId" = grouped_roles."group_id"
	AND "teamMember"."userId" = grouped_roles."user_id"
ON CONFLICT ("team_member_id") DO UPDATE SET
	"role" = EXCLUDED."role",
	"updated_at" = EXCLUDED."updated_at";
--> statement-breakpoint
UPDATE "session" SET "activeOrganizationId" = 'default', "activeTeamId" = NULL;
--> statement-breakpoint
UPDATE "graphs"
SET "organization_id" = 'default', "team_id" = "group_id"
WHERE "group_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "graphs"
SET "organization_id" = 'default'
WHERE "group_id" IS NULL AND "user_id" IS NULL AND "graph_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "graphs" DROP CONSTRAINT IF EXISTS "graphs_group_id_groups_id_fkey";
--> statement-breakpoint
ALTER TABLE "group_users" DROP CONSTRAINT IF EXISTS "group_users_group_id_groups_id_fkey";
--> statement-breakpoint
ALTER TABLE "graphs" DROP CONSTRAINT IF EXISTS "graphs_single_owner_check";
--> statement-breakpoint
DROP INDEX IF EXISTS "graphs_group_type_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "graphs_visible_root_group_name_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "group_users_user_group_idx";
--> statement-breakpoint
ALTER TABLE "graphs" DROP COLUMN IF EXISTS "group_id";
--> statement-breakpoint
DROP TABLE "group_users";
--> statement-breakpoint
DROP TABLE "groups";
--> statement-breakpoint
CREATE INDEX "organization_slug_idx" ON "organization" ("slug");
--> statement-breakpoint
CREATE INDEX "team_organization_idx" ON "team" ("organizationId");
--> statement-breakpoint
CREATE INDEX "member_organization_idx" ON "member" ("organizationId");
--> statement-breakpoint
CREATE INDEX "member_user_idx" ON "member" ("userId");
--> statement-breakpoint
CREATE INDEX "team_member_team_idx" ON "teamMember" ("teamId");
--> statement-breakpoint
CREATE INDEX "team_member_user_idx" ON "teamMember" ("userId");
--> statement-breakpoint
CREATE INDEX "invitation_organization_idx" ON "invitation" ("organizationId");
--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");
--> statement-breakpoint
CREATE INDEX "invitation_role_idx" ON "invitation" ("role");
--> statement-breakpoint
CREATE INDEX "invitation_status_idx" ON "invitation" ("status");
--> statement-breakpoint
CREATE INDEX "invitation_team_idx" ON "invitation" ("teamId");
--> statement-breakpoint
CREATE INDEX "graphs_organization_type_idx" ON "graphs" ("organization_id", "type");
--> statement-breakpoint
CREATE INDEX "graphs_team_type_idx" ON "graphs" ("team_id", "type");
--> statement-breakpoint
CREATE INDEX "graphs_visible_root_organization_name_idx" ON "graphs" ("organization_id", "name") WHERE "graph_id" IS NULL AND "team_id" IS NULL AND "hidden" = false;
--> statement-breakpoint
CREATE INDEX "graphs_visible_root_team_name_idx" ON "graphs" ("team_id", "name") WHERE "graph_id" IS NULL AND "hidden" = false;
--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_organizationId_organization_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_organization_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "teamMember" ADD CONSTRAINT "teamMember_teamId_team_id_fkey" FOREIGN KEY ("teamId") REFERENCES "team"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "teamMember" ADD CONSTRAINT "teamMember_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "team_member_roles" ADD CONSTRAINT "team_member_roles_team_member_id_teamMember_id_fkey" FOREIGN KEY ("team_member_id") REFERENCES "teamMember"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_organization_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_teamId_team_id_fkey" FOREIGN KEY ("teamId") REFERENCES "team"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_user_id_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_activeOrganizationId_organization_id_fkey" FOREIGN KEY ("activeOrganizationId") REFERENCES "organization"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_activeTeamId_team_id_fkey" FOREIGN KEY ("activeTeamId") REFERENCES "team"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_team_organization_fkey" FOREIGN KEY ("team_id", "organization_id") REFERENCES "team"("id", "organizationId") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_team_requires_organization_check" CHECK ("team_id" IS NULL OR "organization_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_single_owner_check" CHECK (((("organization_id" IS NOT NULL)::int + ("user_id" IS NOT NULL)::int + ("graph_id" IS NOT NULL)::int) = 1));
