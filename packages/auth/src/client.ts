import { apiKeyClient } from "@better-auth/api-key/client";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { credentialsClient } from "better-auth-credentials-plugin";

import { ac, admin, manager, user } from "./permissions";

function getBaseURL() {
    if (typeof window === "undefined") {
        return process.env.AUTH_URL || "http://localhost:4321/auth";
    }
    return `${window.location.origin}/auth`;
}

export const authClient = createAuthClient({
    baseURL: getBaseURL(),
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
