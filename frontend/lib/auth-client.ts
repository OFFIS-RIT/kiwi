import { adminClient, jwtClient } from "better-auth/client/plugins";
import { credentialsClient } from "better-auth-credentials-plugin";
import { createAuthClient } from "better-auth/react";

import { ac, admin, manager, user } from "@/lib/auth-permissions";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_AUTH_URL,
  plugins: [
    jwtClient(),
    adminClient({ ac, roles: { admin, manager, user } }),
    credentialsClient(),
  ],
});

let cachedToken: string | null = null;
let cachedAt = 0;
let inflight: Promise<string> | null = null;
const TOKEN_TTL_MS = 4 * 60 * 1000; // 4 minutes

export async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now - cachedAt < TOKEN_TTL_MS) {
    return cachedToken;
  }

  if (inflight) return inflight;

  inflight = authClient
    .token()
    .then(({ data, error }) => {
      if (error || !data?.token) {
        throw new Error("Failed to retrieve auth token");
      }
      cachedToken = data.token;
      cachedAt = Date.now();
      return cachedToken;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function clearTokenCache() {
  cachedToken = null;
  cachedAt = 0;
}
