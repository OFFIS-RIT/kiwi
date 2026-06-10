import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { ulid } from "ulid";

export const userTable = pgTable.withRLS("user", {
    id: text("id")
        .primaryKey()
        .$default(() => ulid()),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("emailVerified").notNull().default(false),
    image: text("image"),
    role: text("role"),
    banned: boolean("banned"),
    banReason: text("banReason"),
    banExpires: text("banExpires"),
    createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true, mode: "date" })
        .notNull()
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
});

export const organizationTable = pgTable.withRLS(
    "organization",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        name: text("name").notNull(),
        slug: text("slug").notNull().unique(),
        logo: text("logo"),
        metadata: text("metadata"),
        createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    },
    (table) => [index("organization_slug_idx").on(table.slug)]
);

export const teamTable = pgTable.withRLS(
    "team",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        name: text("name").notNull(),
        organizationId: text("organizationId")
            .notNull()
            .references(() => organizationTable.id, { onDelete: "cascade" }),
        createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updatedAt", { withTimezone: true, mode: "date" })
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        index("team_organization_idx").on(table.organizationId),
        index("team_name_trgm_idx").using("gin", table.name.op("gin_trgm_ops")),
        unique("team_id_organization_unique").on(table.id, table.organizationId),
    ]
);

export const userPromptsTable = pgTable.withRLS(
    "user_prompts",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        userId: text("user_id")
            .notNull()
            .references(() => userTable.id, { onDelete: "cascade" }),
        prompt: text("prompt").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [index("user_prompts_user_created_idx").on(table.userId, table.createdAt, table.id)]
);

export const teamPromptsTable = pgTable.withRLS(
    "team_prompts",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        teamId: text("team_id")
            .notNull()
            .references(() => teamTable.id, { onDelete: "cascade" }),
        prompt: text("prompt").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [index("team_prompts_team_created_idx").on(table.teamId, table.createdAt, table.id)]
);

export const organizationPromptsTable = pgTable.withRLS(
    "organization_prompts",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organizationTable.id, { onDelete: "cascade" }),
        prompt: text("prompt").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [
        index("organization_prompts_organization_created_idx").on(table.organizationId, table.createdAt, table.id),
    ]
);

export const sessionTable = pgTable.withRLS("session", {
    id: text("id")
        .primaryKey()
        .$default(() => ulid()),
    userId: text("userId")
        .notNull()
        .references(() => userTable.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expiresAt", { withTimezone: true, mode: "date" }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true, mode: "date" })
        .notNull()
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
    impersonatedBy: text("impersonatedBy").references(() => userTable.id, { onDelete: "set null" }),
    activeOrganizationId: text("activeOrganizationId").references(() => organizationTable.id, { onDelete: "set null" }),
    activeTeamId: text("activeTeamId").references(() => teamTable.id, { onDelete: "set null" }),
});

export const accountTable = pgTable.withRLS(
    "account",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        userId: text("userId")
            .notNull()
            .references(() => userTable.id, { onDelete: "cascade" }),
        accountId: text("accountId").notNull(),
        providerId: text("providerId").notNull(),
        accessToken: text("accessToken"),
        refreshToken: text("refreshToken"),
        accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true, mode: "date" }),
        refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true, mode: "date" }),
        scope: text("scope"),
        idToken: text("idToken"),
        password: text("password"),
        createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        updatedAt: timestamp("updatedAt", { withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => sql`NOW()`),
    },
    (table) => [index("account_user_provider_idx").on(table.userId, table.providerId)]
);

export const verificationTable = pgTable.withRLS("verification", {
    id: text("id")
        .primaryKey()
        .$default(() => ulid()),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true, mode: "date" })
        .notNull()
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
});

export const memberTable = pgTable.withRLS(
    "member",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        organizationId: text("organizationId")
            .notNull()
            .references(() => organizationTable.id, { onDelete: "cascade" }),
        userId: text("userId")
            .notNull()
            .references(() => userTable.id, { onDelete: "cascade" }),
        role: text("role").notNull().default("member"),
        systemRoleProvisioned: boolean("systemRoleProvisioned").notNull().default(false),
        createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    },
    (table) => [
        index("member_organization_idx").on(table.organizationId),
        index("member_user_idx").on(table.userId),
        uniqueIndex("member_organization_user_unique").on(table.organizationId, table.userId),
    ]
);

export const invitationTable = pgTable.withRLS(
    "invitation",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        organizationId: text("organizationId")
            .notNull()
            .references(() => organizationTable.id, { onDelete: "cascade" }),
        email: text("email").notNull(),
        role: text("role").notNull(),
        status: text("status").notNull().default("pending"),
        teamId: text("teamId").references(() => teamTable.id, { onDelete: "set null" }),
        expiresAt: timestamp("expiresAt", { withTimezone: true, mode: "date" }).notNull(),
        inviterId: text("inviterId")
            .notNull()
            .references(() => userTable.id, { onDelete: "cascade" }),
        createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    },
    (table) => [
        index("invitation_organization_idx").on(table.organizationId),
        index("invitation_email_idx").on(table.email),
        index("invitation_role_idx").on(table.role),
        index("invitation_status_idx").on(table.status),
        index("invitation_team_idx").on(table.teamId),
    ]
);

export const teamMemberTable = pgTable.withRLS(
    "teamMember",
    {
        id: text("id")
            .primaryKey()
            .$default(() => ulid()),
        teamId: text("teamId")
            .notNull()
            .references(() => teamTable.id, { onDelete: "cascade" }),
        userId: text("userId")
            .notNull()
            .references(() => userTable.id, { onDelete: "cascade" }),
        createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }).defaultNow(),
    },
    (table) => [
        index("team_member_team_idx").on(table.teamId),
        index("team_member_user_idx").on(table.userId),
        uniqueIndex("team_member_team_user_unique").on(table.teamId, table.userId),
    ]
);

export const TEAM_MEMBER_ROLE_VALUES = ["admin", "moderator", "member"] as const;
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLE_VALUES)[number];

export const teamMemberRolesTable = pgTable("team_member_roles", {
    teamMemberId: text("team_member_id")
        .primaryKey()
        .references(() => teamMemberTable.id, { onDelete: "cascade" }),
    role: text("role", { enum: TEAM_MEMBER_ROLE_VALUES }).notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
        .notNull()
        .defaultNow()
        .$onUpdate(() => sql`NOW()`),
});

export const apikey = pgTable("apikey", {
    id: text("id").primaryKey().unique(),
    configId: text("config_id").notNull(),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    referenceId: text("reference_id").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { precision: 6, withTimezone: true }),
    enabled: boolean("enabled"),
    rateLimitEnabled: boolean("rate_limit_enabled"),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count"),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { precision: 6, withTimezone: true }),
    expiresAt: timestamp("expires_at", { precision: 6, withTimezone: true }),
    createdAt: timestamp("created_at", { precision: 6, withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { precision: 6, withTimezone: true }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
});
