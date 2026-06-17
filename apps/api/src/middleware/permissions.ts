import type { Context } from "elysia";
import * as Effect from "effect/Effect";
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
): Effect.Effect<void, unknown> {
    return Effect.tryPromise({
        try: async () => {
            const headersToUse = options?.apiKeyOnly ? getApiKeyHeaders(headers) : getAuthHeaders(headers);
            let organizationId = options?.organizationId ?? null;

            const session = await auth.api.getSession({ headers: headersToUse });
            if (isSystemAdminRole(session?.user.role)) {
                return;
            }

            if (!organizationId) {
                organizationId = session?.session.activeOrganizationId ?? (await Effect.runPromise(getDefaultOrganizationId()));
            }

            const result = await auth.api.hasPermission({
                headers: headersToUse,
                body: {
                    organizationId,
                    permissions,
                },
            });

            if (!result.success) {
                throw new Error(API_ERROR_CODES.FORBIDDEN);
            }
        },
        catch: (error) => error,
    });
}

export function requirePermissions(permissions: KiwiPermissions) {
    return async ({ request, session, status }: PermissionContext) => {
        if (!session) {
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        }

        try {
            await Effect.runPromise(
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
