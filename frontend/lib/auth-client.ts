"use client";

import { jwtClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const LOCAL_AUTH_HOSTS = new Set(["localhost", "127.0.0.1"]);

type TokenCacheEntry = {
  token: string;
  expiresAt: number | null;
};

function resolveAuthBaseUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_AUTH_URL?.trim();
  if (configuredUrl) {
    if (typeof window === "undefined" && configuredUrl.startsWith("/")) {
      return `http://localhost:4321${configuredUrl}`;
    }

    return configuredUrl;
  }

  if (typeof window === "undefined") {
    return "http://localhost:4321/auth";
  }

  if (LOCAL_AUTH_HOSTS.has(window.location.hostname)) {
    return "http://localhost:4321/auth";
  }

  return `${window.location.origin}/auth`;
}

function decodeBase64Url(value: string) {
  if (typeof atob === "undefined") {
    return null;
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);

  try {
    return atob(normalized + padding);
  } catch {
    return null;
  }
}

function getTokenExpiry(token: string) {
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) {
    return null;
  }

  const decodedPayload = decodeBase64Url(payloadSegment);
  if (!decodedPayload) {
    return null;
  }

  try {
    const payload = JSON.parse(decodedPayload) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isTokenFresh(cacheEntry: TokenCacheEntry | null) {
  if (!cacheEntry) {
    return false;
  }

  if (cacheEntry.expiresAt === null) {
    return true;
  }

  return cacheEntry.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS;
}

function cacheToken(token: string) {
  tokenCache = {
    token,
    expiresAt: getTokenExpiry(token),
  };

  return token;
}

export const AUTH_BASE_URL = resolveAuthBaseUrl();

export const authClient = createAuthClient({
  baseURL: AUTH_BASE_URL,
  plugins: [jwtClient()],
});

export type AuthSession = typeof authClient.$Infer.Session;
export type AuthUser = AuthSession["user"];

let tokenCache: TokenCacheEntry | null = null;
let tokenRefreshPromise: Promise<string | null> | null = null;

export function clearAuthTokenCache() {
  tokenCache = null;
  tokenRefreshPromise = null;
}

export function getCachedAuthToken() {
  return tokenCache?.token ?? null;
}

export async function getAuthToken(options: { forceRefresh?: boolean } = {}) {
  const { forceRefresh = false } = options;

  if (typeof window === "undefined") {
    return null;
  }

  if (!forceRefresh && isTokenFresh(tokenCache)) {
    return tokenCache?.token ?? null;
  }

  if (!tokenRefreshPromise) {
    tokenRefreshPromise = (async () => {
      const response = await authClient.token();

      if (response.error || !response.data?.token) {
        clearAuthTokenCache();
        return null;
      }

      return cacheToken(response.data.token);
    })().finally(() => {
      tokenRefreshPromise = null;
    });
  }

  return tokenRefreshPromise;
}

export async function primeAuthTokenCache() {
  await getAuthToken();
}
