import Elysia from "elysia";
import { auth } from "@kiwi/auth/server";
import { db } from "@kiwi/db";
import { userTable } from "@kiwi/db/tables/auth";
import { error as logError, info as logInfo } from "@kiwi/logger";
import { env } from "../env";

const masterUserId = env.MASTER_USER_ID?.trim() || undefined;
const masterUserRole = env.MASTER_USER_ROLE?.trim() || "admin";
const masterUserName = env.MASTER_USER_NAME?.trim() || "Master User";
const masterUserEmail = env.MASTER_USER_EMAIL?.trim() || undefined;

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
                    role: masterUserRole,
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
                        role: masterUserRole,
                        banned: false,
                        banReason: null,
                        banExpires: null,
                    },
                });

            logInfo("ensured master user", "userId", masterUserId, "role", masterUserRole);
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

export const authMiddleware = new Elysia({ name: "auth-middleware" }).derive({ as: "scoped" }, async ({ request }) => {
    await ensureMasterUser();

    const session = await getAuthSession(request.headers);

    return {
        session,
        user: session?.user ?? null,
    };
});
