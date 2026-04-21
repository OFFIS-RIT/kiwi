import type { Context } from "elysia";
import type { KiwiPermissions } from "@kiwi/auth/permissions";
import { auth } from "@kiwi/auth/server";
import { API_ERROR_CODES, errorResponse } from "../types";
import { getAuthHeaders, type AuthSession, type AuthUser } from "./auth";

type PermissionContext = Context & {
    session: AuthSession;
    user: AuthUser | null;
};

export function requirePermissions(permissions: KiwiPermissions) {
    return async ({ request, session, status }: PermissionContext) => {
        if (!session) {
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        }

        const result = await auth.api.userHasPermission({
            headers: getAuthHeaders(request.headers),
            body: {
                permissions,
            },
        });

        if (!result.success) {
            return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
        }
    };
}
