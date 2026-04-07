"use client";

import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { credentialsClient } from "better-auth-credentials-plugin";

import { ac, admin, manager, user } from "./permissions";

function getBaseURL() {
    const url = process.env.NEXT_PUBLIC_AUTH_URL || "/auth";

    if (typeof window === "undefined" && url.startsWith("/")) {
        return `http://localhost:3000${url}`;
    }

    return url;
}

export const authClient = createAuthClient({
    baseURL: getBaseURL(),
    plugins: [adminClient({ ac, roles: { admin, manager, user } }), credentialsClient()],
});
