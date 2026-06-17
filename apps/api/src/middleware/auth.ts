import Elysia from "elysia";
import * as Effect from "effect/Effect";
import { auth, isSystemAdminRole } from "@kiwi/auth/server";

export type AuthSessionUser = {
    id: string;
    email?: string | null;
    name?: string | null;
    role?: string | null;
} & Record<string, unknown>;

export type AuthSessionRecord = {
    activeOrganizationId?: string | null;
    activeTeamId?: string | null;
} & Record<string, unknown>;

export type AuthSession = {
    user: AuthSessionUser;
    session: AuthSessionRecord;
} | null;

export type AuthUser = AuthSessionUser & {
    role?: string | null;
    activeOrganizationId: string | null;
    activeTeamId: string | null;
    isSystemAdmin: boolean;
};

export function getAuthSession(headers: Headers): Effect.Effect<AuthSession, unknown> {
    return Effect.tryPromise({
        try: async () =>
            (await auth.api.getSession({
                headers: getAuthHeaders(headers),
            })) as AuthSession,
        catch: (error) => error,
    });
}

function toAuthUser(session: AuthSession): AuthUser | null {
    if (!session) {
        return null;
    }

    const role = typeof session.user.role === "string" ? session.user.role : null;

    return {
        ...session.user,
        role,
        activeOrganizationId: session.session.activeOrganizationId ?? null,
        activeTeamId: session.session.activeTeamId ?? null,
        isSystemAdmin: isSystemAdminRole(role),
    };
}

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

export function getApiKeyHeaders(headers: Headers) {
    const normalizedHeaders = new Headers();
    const apiKey = headers.get("x-api-key")?.trim();
    const token = apiKey && apiKey.length > 0 ? apiKey : getAuthorizationToken(headers);

    if (token) {
        normalizedHeaders.set("x-api-key", token);
    }

    return normalizedHeaders;
}

function createAuthMiddleware(name: string, getHeaders: (headers: Headers) => Headers) {
    return new Elysia({ name }).derive({ as: "scoped" }, async ({ request }) => {
        const session = await Effect.runPromise(
            Effect.tryPromise({
                try: async () =>
                    (await auth.api.getSession({
                        headers: getHeaders(request.headers),
                    })) as AuthSession,
                catch: (error) => error,
            })
        );

        return {
            session,
            user: toAuthUser(session),
        };
    });
}

export const authMiddleware = createAuthMiddleware("auth-middleware", getAuthHeaders);
export const mcpAuthMiddleware = createAuthMiddleware("mcp-auth-middleware", getApiKeyHeaders);
