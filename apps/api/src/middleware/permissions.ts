import type { Context } from "elysia";
import type { KiwiPermissions } from "@kiwi/auth/permissions";
import { auth } from "@kiwi/auth/server";
import { API_ERROR_CODES, errorResponse } from "../types";
import { getApiKeyHeaders, getAuthHeaders, type AuthSession, type AuthUser } from "./auth";

type PermissionContext = Context & {
    session: AuthSession;
    user: AuthUser | null;
};

export async function assertPermissions(
    headers: Headers,
    permissions: KiwiPermissions,
    options?: { apiKeyOnly?: boolean }
) {
    const result = await auth.api.userHasPermission({
        headers: options?.apiKeyOnly ? getApiKeyHeaders(headers) : getAuthHeaders(headers),
        body: {
            permissions,
        },
    });

    if (!result.success) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
}

export function requirePermissions(permissions: KiwiPermissions) {
    return async ({ request, session, status }: PermissionContext) => {
        if (!session) {
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        }

        try {
            await assertPermissions(request.headers, permissions);
        } catch {
            return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
        }
    };
}
