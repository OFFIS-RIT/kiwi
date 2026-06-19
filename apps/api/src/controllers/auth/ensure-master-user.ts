import * as Effect from "effect/Effect";
import { defaultKeyHasher } from "@better-auth/api-key";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import {
    API_KEY_RATE_LIMIT_MAX_REQUESTS,
    API_KEY_RATE_LIMIT_TIME_WINDOW,
    ensureDefaultOrganizationMember,
    ensureSystemAdminOrganizationMemberships,
} from "@kiwi/auth/server";
import { tryDb, tryDbVoid } from "@kiwi/db/effect";
import { accountTable, apikey as apiKeyTable, userTable } from "@kiwi/db/tables/auth";
import { error as logError, info as logInfo } from "@kiwi/logger";
import { env } from "../../env";
import { toApiError } from "../_shared/api-effect";

const masterUserId = env.MASTER_USER_ID?.trim() || undefined;
const masterUserName = env.MASTER_USER_NAME?.trim() || "Master User";
const masterUserEmail = env.MASTER_USER_EMAIL?.trim() || undefined;
const masterUserPassword = env.MASTER_USER_PASSWORD?.trim() || undefined;
const masterUserApiKey = env.MASTER_USER_API_KEY?.trim() || undefined;
const masterUserApiKeyRecordId = masterUserId ? `master-user-api-key:${masterUserId}` : undefined;

function ensureMasterUserOnce(masterUserId: string) {
    return Effect.gen(function* () {
        const existingUsers = yield* tryDb((db) =>
            db.select({ id: userTable.id, email: userTable.email }).from(userTable)
        );
        const existingUser = existingUsers.find((user) => user.id === masterUserId);
        const email = masterUserEmail || existingUser?.email || `${masterUserId}@local`;

        yield* tryDbVoid((db) =>
            db
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
                })
        );

        yield* ensureDefaultOrganizationMember(masterUserId, "admin");
        yield* ensureSystemAdminOrganizationMemberships(masterUserId);

        if (masterUserPassword) {
            const password = yield* Effect.tryPromise({
                try: () => hashPassword(masterUserPassword),
                catch: toApiError,
            });
            const existingCredentialAccount = yield* tryDb((db) =>
                db
                    .select({ id: accountTable.id })
                    .from(accountTable)
                    .where(and(eq(accountTable.userId, masterUserId), eq(accountTable.providerId, "credential")))
                    .limit(1)
            );

            if (existingCredentialAccount.length > 0) {
                yield* tryDbVoid((db) =>
                    db
                        .update(accountTable)
                        .set({
                            accountId: masterUserId,
                            password,
                        })
                        .where(and(eq(accountTable.userId, masterUserId), eq(accountTable.providerId, "credential")))
                );
            } else {
                yield* tryDbVoid((db) =>
                    db.insert(accountTable).values({
                        userId: masterUserId,
                        accountId: masterUserId,
                        providerId: "credential",
                        password,
                    })
                );
            }
        } else if (masterUserEmail) {
            logInfo("master user password not configured; skipping credential account bootstrap", {
                userId: masterUserId,
                email,
            });
        }

        if (masterUserApiKeyRecordId) {
            if (!masterUserApiKey) {
                yield* tryDbVoid((db) => db.delete(apiKeyTable).where(eq(apiKeyTable.id, masterUserApiKeyRecordId)));
            } else {
                const hashedApiKey = yield* Effect.tryPromise({
                    try: () => defaultKeyHasher(masterUserApiKey),
                    catch: toApiError,
                });
                const now = new Date();

                yield* tryDbVoid((db) =>
                    db
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
                            rateLimitEnabled: true,
                            rateLimitTimeWindow: API_KEY_RATE_LIMIT_TIME_WINDOW,
                            rateLimitMax: API_KEY_RATE_LIMIT_MAX_REQUESTS,
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
                                rateLimitEnabled: true,
                                rateLimitTimeWindow: API_KEY_RATE_LIMIT_TIME_WINDOW,
                                rateLimitMax: API_KEY_RATE_LIMIT_MAX_REQUESTS,
                                requestCount: 0,
                                remaining: null,
                                lastRequest: null,
                                expiresAt: null,
                                updatedAt: now,
                                permissions: null,
                                metadata: null,
                            },
                        })
                );
            }
        }

        logInfo("ensured master user", { userId: masterUserId, systemRole: "admin", organizationRole: "admin" });
    });
}

export function ensureMasterUser() {
    return Effect.mapError(
        Effect.gen(function* () {
            if (!masterUserId) {
                return;
            }

            yield* Effect.catch(ensureMasterUserOnce(masterUserId), (error: unknown) => {
                logError("failed to ensure master user", { userId: masterUserId, error });
                return Effect.void;
            });
        }),
        toApiError
    );
}
