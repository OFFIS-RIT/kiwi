import Elysia from "elysia";
import { defaultKeyHasher } from "@better-auth/api-key";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { auth } from "@kiwi/auth/server";
import { db } from "@kiwi/db";
import { accountTable, apikey as apiKeyTable, userTable } from "@kiwi/db/tables/auth";
import { error as logError, info as logInfo } from "@kiwi/logger";
import { env } from "../env";

const masterUserId = env.MASTER_USER_ID?.trim() || undefined;
const masterUserName = env.MASTER_USER_NAME?.trim() || "Master User";
const masterUserEmail = env.MASTER_USER_EMAIL?.trim() || undefined;
const masterUserPassword = env.MASTER_USER_PASSWORD?.trim() || undefined;
const masterUserApiKey = env.MASTER_USER_API_KEY?.trim() || undefined;
const masterUserApiKeyRecordId = masterUserId ? `master-user-api-key:${masterUserId}` : undefined;

let ensureMasterUserPromise: Promise<void> | null = null;

async function ensureMasterUser() {
    if (!masterUserId) {
        return;
    }

    if (!ensureMasterUserPromise) {
        ensureMasterUserPromise = (async () => {
            const existingUsers = await db.select({ id: userTable.id, email: userTable.email }).from(userTable);
            const existingUser = existingUsers.find((user) => user.id === masterUserId);

            const email = masterUserEmail || existingUser?.email || `${masterUserId}@local`;

            await db
                .insert(userTable)
                .values({
                    id: masterUserId,
                    name: masterUserName,
                    email,
                    emailVerified: true,
                    role: "admin",
                    banned: false,
                    banReason: null,
                    banExpires: null,
                })
                .onConflictDoUpdate({
                    target: userTable.id,
                    set: {
                        name: masterUserName,
                        email,
                        emailVerified: true,
                        role: "admin",
                        banned: false,
                        banReason: null,
                        banExpires: null,
                    },
                });

            if (masterUserPassword) {
                const password = await hashPassword(masterUserPassword);
                const existingCredentialAccount = await db
                    .select({ id: accountTable.id })
                    .from(accountTable)
                    .where(and(eq(accountTable.userId, masterUserId), eq(accountTable.providerId, "credential")))
                    .limit(1);

                if (existingCredentialAccount.length > 0) {
                    await db
                        .update(accountTable)
                        .set({
                            accountId: masterUserId,
                            password,
                        })
                        .where(and(eq(accountTable.userId, masterUserId), eq(accountTable.providerId, "credential")));
                } else {
                    await db.insert(accountTable).values({
                        userId: masterUserId,
                        accountId: masterUserId,
                        providerId: "credential",
                        password,
                    });
                }
            } else if (masterUserEmail) {
                logInfo("master user password not configured; skipping credential account bootstrap", {
                    userId: masterUserId,
                    email,
                });
            }

            if (masterUserApiKeyRecordId) {
                if (!masterUserApiKey) {
                    await db.delete(apiKeyTable).where(eq(apiKeyTable.id, masterUserApiKeyRecordId));
                } else {
                    const hashedApiKey = await defaultKeyHasher(masterUserApiKey);
                    const now = new Date();

                    await db
                        .insert(apiKeyTable)
                        .values({
                            id: masterUserApiKeyRecordId,
                            configId: "default",
                            name: "Master User API Key",
                            start: masterUserApiKey.slice(0, 6) || null,
                            prefix: null,
                            key: hashedApiKey,
                            referenceId: masterUserId,
                            refillInterval: null,
                            refillAmount: null,
                            lastRefillAt: null,
                            enabled: true,
                            rateLimitEnabled: false,
                            rateLimitTimeWindow: null,
                            rateLimitMax: null,
                            requestCount: 0,
                            remaining: null,
                            lastRequest: null,
                            expiresAt: null,
                            createdAt: now,
                            updatedAt: now,
                            permissions: null,
                            metadata: null,
                        })
                        .onConflictDoUpdate({
                            target: apiKeyTable.id,
                            set: {
                                configId: "default",
                                name: "Master User API Key",
                                start: masterUserApiKey.slice(0, 6) || null,
                                prefix: null,
                                key: hashedApiKey,
                                referenceId: masterUserId,
                                refillInterval: null,
                                refillAmount: null,
                                lastRefillAt: null,
                                enabled: true,
                                rateLimitEnabled: false,
                                rateLimitTimeWindow: null,
                                rateLimitMax: null,
                                requestCount: 0,
                                remaining: null,
                                lastRequest: null,
                                expiresAt: null,
                                updatedAt: now,
                                permissions: null,
                                metadata: null,
                            },
                        });
                }
            }

            logInfo("ensured master user", { userId: masterUserId, role: "admin" });
        })().catch((error) => {
            ensureMasterUserPromise = null;

            logError("failed to ensure master user", { userId: masterUserId, error });
        });
    }

    await ensureMasterUserPromise;
}

export const getAuthSession = (headers: Headers) =>
    auth.api.getSession({
        headers: getAuthHeaders(headers),
    });

export type AuthSession = Awaited<ReturnType<typeof getAuthSession>>;
export type AuthUser = NonNullable<AuthSession>["user"];

function getAuthorizationToken(headers: Headers) {
    const authorization = headers.get("authorization")?.trim();
    if (!authorization) {
        return undefined;
    }

    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
    if (bearerMatch?.[1]) {
        return bearerMatch[1].trim();
    }

    return authorization.includes(" ") ? undefined : authorization;
}

export function getAuthHeaders(headers: Headers) {
    const normalizedHeaders = new Headers(headers);

    if (!normalizedHeaders.has("x-api-key")) {
        const token = getAuthorizationToken(normalizedHeaders);

        if (token) {
            normalizedHeaders.set("x-api-key", token);
        }
    }

    return normalizedHeaders;
}

export const authMiddleware = new Elysia({ name: "auth-middleware" }).derive({ as: "scoped" }, async ({ request }) => {
    await ensureMasterUser();

    const session = await getAuthSession(request.headers);

    return {
        session,
        user: session?.user ?? null,
    };
});
