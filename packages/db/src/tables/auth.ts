import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ulid } from "ulid";

export const userTable = pgTable.withRLS("users", {
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

export const sessionTable = pgTable.withRLS("sessions", {
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

export const accountTable = pgTable.withRLS("accounts", {
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
