import type { Context } from "elysia";
import type { KiwiPermissions } from "@kiwi/auth/permissions";
import { auth } from "@kiwi/auth/server";
import { API_ERROR_CODES, errorResponse } from "../types";
import type { AuthSession, AuthUser } from "./auth";

type PermissionContext = Context & {
    isMasterBypass?: boolean;
    session: AuthSession;
    user: AuthUser | null;
};

export function requirePermissions(permissions: KiwiPermissions) {
    return async ({ request, session, status, isMasterBypass }: PermissionContext) => {
        if (!session) {
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        }

        if (isMasterBypass) {
            return;
        }

        const result = await auth.api.userHasPermission({
            headers: request.headers,
            body: {
                permissions,
            },
        });

        if (!result.success) {
            return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
        }
    };
}
