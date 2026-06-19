import type { Context } from "elysia";
import * as Effect from "effect/Effect";
import { runDatabaseEffect, type Database } from "@kiwi/db/effect";
import type { KiwiPermissions } from "@kiwi/auth/permissions";
import { auth, getDefaultOrganizationId, isSystemAdminRole } from "@kiwi/auth/server";
import {
    API_ERROR_CODES,
    type ApiError,
    errorResponse,
    forbiddenError,
    internalServerError,
    isApiError,
} from "../types";
import { getApiKeyHeaders, getAuthHeaders, type AuthSession, type AuthUser } from "./auth";

type PermissionContext = Context & {
    session: AuthSession;
    user: AuthUser | null;
};

export function assertPermissions(
    headers: Headers,
    permissions: KiwiPermissions,
    options?: { apiKeyOnly?: boolean; organizationId?: string | null }
): Effect.Effect<void, ApiError, Database> {
    return Effect.gen(function* () {
        const headersToUse = options?.apiKeyOnly ? getApiKeyHeaders(headers) : getAuthHeaders(headers);
        let organizationId = options?.organizationId ?? null;

        const session = yield* Effect.tryPromise({
            try: () => auth.api.getSession({ headers: headersToUse }),
            catch: () => internalServerError("Unable to verify session permissions"),
        });
        if (isSystemAdminRole(session?.user.role)) {
            return;
        }

        if (!organizationId) {
            organizationId =
                session?.session.activeOrganizationId ??
                (yield* Effect.mapError(getDefaultOrganizationId(), () =>
                    internalServerError("Unable to load default organization")
                ));
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
            catch: () => internalServerError("Unable to verify organization permissions"),
        });

        if (!result.success) {
            return yield* Effect.fail(forbiddenError());
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
            if (isApiError(error) && error.code === API_ERROR_CODES.FORBIDDEN) {
                return status(error.status, errorResponse(error.responseMessage, error.code));
            }

            throw error;
        }
    };
}
