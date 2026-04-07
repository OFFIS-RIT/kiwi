import Elysia from "elysia";
import { auth } from "@kiwi/auth/server";

export const getAuthSession = (headers: Headers) =>
    auth.api.getSession({
        headers,
    });

export type AuthSession = Awaited<ReturnType<typeof getAuthSession>>;
export type AuthUser = NonNullable<AuthSession>["user"];

export const authMiddleware = new Elysia({ name: "auth-middleware" }).derive({ as: "scoped" }, async ({ request }) => {
    const session = await getAuthSession(request.headers);

    return {
        session,
        user: session?.user ?? null,
    };
});
