import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
    imposonatedBy: text("imposonatedBy").references(() => userTable.id, { onDelete: "set null" }),
});

export const accountTable = pgTable.withRLS("account", {
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
});

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
