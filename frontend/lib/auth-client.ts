import { createAuthClient } from "better-auth/react";
import { jwtClient } from "better-auth/client/plugins";

// Pattern analog zu NEXT_PUBLIC_API_URL
const AUTH_BASE_URL = process.env.NEXT_PUBLIC_AUTH_URL;

export const authClient = createAuthClient({
    baseURL: AUTH_BASE_URL,
    basePath: "/auth", // Auth-Service verwendet /auth statt /api/auth
    plugins: [jwtClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
