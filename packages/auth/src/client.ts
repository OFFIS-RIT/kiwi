"use client";

import { apiKeyClient } from "@better-auth/api-key/client";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { credentialsClient } from "better-auth-credentials-plugin";

import { ac, admin, manager, user } from "./permissions";

export const authClient = createAuthClient({
    baseURL: typeof window !== "undefined" ? `${window.location.origin}/auth` : "http://localhost/auth",
    plugins: [
        inferAdditionalFields({
            user: {
                role: {
                    type: "string",
                    input: false,
                },
            },
        }),
        apiKeyClient(),
        adminClient({ ac, roles: { admin, manager, user } }),
        credentialsClient(),
    ],
});
