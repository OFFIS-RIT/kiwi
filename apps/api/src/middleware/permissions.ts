import type { Context } from "elysia";
import * as Effect from "effect/Effect";
import { runDatabaseEffect, type Database } from "@kiwi/db/effect";
import type { KiwiPermissions } from "@kiwi/auth/permissions";
import { auth, getDefaultOrganizationId, isSystemAdminRole } from "@kiwi/auth/server";
import { API_ERROR_CODES, errorResponse } from "../types";
import { getApiKeyHeaders, getAuthHeaders, type AuthSession, type AuthUser } from "./auth";

type PermissionContext = Context & {
    session: AuthSession;
    user: AuthUser | null;
};

export function assertPermissions(
    headers: Headers,
    permissions: KiwiPermissions,
    options?: { apiKeyOnly?: boolean; organizationId?: string | null }
): Effect.Effect<void, unknown, Database> {
    return Effect.gen(function* () {
        const headersToUse = options?.apiKeyOnly ? getApiKeyHeaders(headers) : getAuthHeaders(headers);
        let organizationId = options?.organizationId ?? null;

        const session = yield* Effect.tryPromise({
            try: () => auth.api.getSession({ headers: headersToUse }),
            catch: (error) => error,
        });
        if (isSystemAdminRole(session?.user.role)) {
            return;
        }

        if (!organizationId) {
            organizationId = session?.session.activeOrganizationId ?? (yield* getDefaultOrganizationId());
        }

        const result = yield* Effect.tryPromise({
            try: () =>
                auth.api.hasPermission({
                    headers: headersToUse,
                    body: {
                        organizationId,
                        permissions,
                    },
                }),
            catch: (error) => error,
        });

        if (!result.success) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }
    });
}

export function requirePermissions(permissions: KiwiPermissions) {
    return async ({ request, session, status }: PermissionContext) => {
        if (!session) {
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        }

        try {
            await runDatabaseEffect(
                assertPermissions(request.headers, permissions, {
                    organizationId: session.session.activeOrganizationId,
                })
            );
        } catch (error) {
            if (error instanceof Error && error.message === API_ERROR_CODES.FORBIDDEN) {
                return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
            }

            throw error;
        }
    };
}
