"use client";

import { apiKeyClient } from "@better-auth/api-key/client";
import { adminClient, inferAdditionalFields, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { credentialsClient } from "better-auth-credentials-plugin";

import { ac, admin, member, systemAdmin, user } from "./permissions";

/**
 * Better Auth requires an absolute URL even when evaluated server-side during
 * Next.js static generation. Relative paths (e.g. "/auth") are valid in the
 * browser but throw `ERR_INVALID_URL` when no `window` is present. We resolve
 * relative paths against the current origin client-side and fall back to a
 * placeholder host server-side — the placeholder is never used for real
 * requests since the auth client only fires from the browser.
 */
function resolveBaseURL(baseURL: string): string {
    if (baseURL.startsWith("http://") || baseURL.startsWith("https://")) {
        return baseURL;
    }
    if ("window" in globalThis) {
        const win = (globalThis as unknown as { window: { location: { origin: string } } }).window;
        return `${win.location.origin}${baseURL}`;
    }
    return `http://localhost:3000${baseURL}`;
}

export function createKiwiAuthClient(baseURL: string) {
    return createAuthClient({
        baseURL: resolveBaseURL(baseURL),
        plugins: [
            inferAdditionalFields({
                user: { role: { type: "string", input: false } },
                session: {
                    activeOrganizationId: {
                        type: "string",
                        input: false,
                    },
                    activeTeamId: {
                        type: "string",
                        input: false,
                    },
                },
            }),
            apiKeyClient(),
            adminClient({ ac, roles: { admin: systemAdmin, user } }),
            organizationClient({ ac, roles: { admin, member } }),
            credentialsClient(),
        ],
    });
}

export type KiwiAuthClient = ReturnType<typeof createKiwiAuthClient>;
