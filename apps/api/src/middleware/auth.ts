import Elysia from "elysia";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { auth } from "@kiwi/auth/server";
import { db } from "@kiwi/db";
import { accountTable, userTable } from "@kiwi/db/tables/auth";
import { error as logError, info as logInfo } from "@kiwi/logger";
import { env } from "../env";

const masterUserId = env.MASTER_USER_ID?.trim() || undefined;
const masterUserName = env.MASTER_USER_NAME?.trim() || "Master User";
const masterUserEmail = env.MASTER_USER_EMAIL?.trim() || undefined;
const masterUserPassword = env.MASTER_USER_PASSWORD?.trim() || undefined;
const masterUserBypassToken = env.MASTER_USER_API_BYPASS?.trim() || undefined;

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
                logInfo(
                    "master user password not configured; skipping credential account bootstrap",
                    "userId",
                    masterUserId,
                    "email",
                    email,
                );
            }

            logInfo("ensured master user", "userId", masterUserId, "role", "admin");
        })().catch((error) => {
            ensureMasterUserPromise = null;

            logError("failed to ensure master user", "userId", masterUserId, "error", error);
        });
    }

    await ensureMasterUserPromise;
}

export const getAuthSession = (headers: Headers) =>
    auth.api.getSession({
        headers,
    });

export type AuthSession = Awaited<ReturnType<typeof getAuthSession>>;
export type AuthUser = NonNullable<AuthSession>["user"];

function getAuthorizationToken(headers: Headers) {
    const authorization = headers.get("authorization")?.trim();
    if (!authorization) {
        return undefined;
    }

    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
    return bearerMatch?.[1]?.trim() || authorization;
}

function isMasterBypass(headers: Headers) {
    const token = getAuthorizationToken(headers);

    return Boolean(masterUserId && masterUserBypassToken && token && token === masterUserBypassToken);
}

async function getBypassSession(): Promise<AuthSession> {
    if (!masterUserId) {
        return null;
    }

    const [user] = await db.select().from(userTable).where(eq(userTable.id, masterUserId)).limit(1);
    if (!user) {
        return null;
    }

    return {
        session: {
            id: "master-user-api-bypass",
            userId: user.id,
            expiresAt: new Date("9999-12-31T23:59:59.999Z"),
            createdAt: new Date(),
            updatedAt: new Date(),
            token: "master-user-api-bypass",
        },
        user,
    } as AuthSession;
}

export const authMiddleware = new Elysia({ name: "auth-middleware" }).derive({ as: "scoped" }, async ({ request }) => {
    await ensureMasterUser();

    const isMasterBypassRequest = isMasterBypass(request.headers);
    const session = isMasterBypassRequest ? await getBypassSession() : await getAuthSession(request.headers);

    return {
        isMasterBypass: isMasterBypassRequest,
        session,
        user: session?.user ?? null,
    };
});
