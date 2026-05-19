"use client";

import { apiKeyClient } from "@better-auth/api-key/client";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { credentialsClient } from "better-auth-credentials-plugin";

import { ac, admin, manager, user } from "./permissions";

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
    if (typeof window !== "undefined") {
        return `${window.location.origin}${baseURL}`;
    }
    return `http://localhost:3000${baseURL}`;
}

export function createKiwiAuthClient(baseURL: string) {
    return createAuthClient({
        baseURL: resolveBaseURL(baseURL),
        plugins: [
            inferAdditionalFields({
                user: { role: { type: "string", input: false } },
            }),
            apiKeyClient(),
            adminClient({ ac, roles: { admin, manager, user } }),
            credentialsClient(),
        ],
    });
}

export type KiwiAuthClient = ReturnType<typeof createKiwiAuthClient>;
