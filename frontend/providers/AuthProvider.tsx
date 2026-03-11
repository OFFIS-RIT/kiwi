"use client";

import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";

import {
  authClient,
  type AuthSession,
  type AuthUser,
  clearAuthTokenCache,
  getAuthToken,
  primeAuthTokenCache,
} from "@/lib/auth-client";

type LoginInput = {
  email: string;
  password: string;
  rememberMe?: boolean;
};

type RegisterInput = {
  name: string;
  email: string;
  password: string;
};

type AuthContextType = {
  session: AuthSession | null;
  user: AuthUser | null;
  isPending: boolean;
  isAuthenticated: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  getAccessToken: (options?: {
    forceRefresh?: boolean;
  }) => Promise<string | null>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function getAuthErrorMessage(error: { message?: string } | null | undefined) {
  return error?.message || "Authentication failed";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending, refetch } = authClient.useSession();

  useEffect(() => {
    if (!session) {
      clearAuthTokenCache();
      return;
    }

    void primeAuthTokenCache();
  }, [session]);

  const refreshSession = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const login = useCallback(
    async ({ email, password, rememberMe = true }: LoginInput) => {
      const response = await authClient.signIn.email({
        email,
        password,
        rememberMe,
      });

      if (response.error) {
        throw new Error(getAuthErrorMessage(response.error));
      }

      clearAuthTokenCache();
      await refetch();
      await primeAuthTokenCache();
    },
    [refetch]
  );

  const register = useCallback(
    async ({ name, email, password }: RegisterInput) => {
      const response = await authClient.signUp.email({
        name,
        email,
        password,
      });

      if (response.error) {
        throw new Error(getAuthErrorMessage(response.error));
      }

      clearAuthTokenCache();
      await refetch();
      await primeAuthTokenCache();
    },
    [refetch]
  );

  const logout = useCallback(async () => {
    const response = await authClient.signOut();

    clearAuthTokenCache();
    await refetch();

    if (response.error) {
      throw new Error(getAuthErrorMessage(response.error));
    }
  }, [refetch]);

  const value = useMemo<AuthContextType>(
    () => ({
      session: session ?? null,
      user: session?.user ?? null,
      isPending,
      isAuthenticated: Boolean(session?.user),
      login,
      register,
      logout,
      refreshSession,
      getAccessToken: getAuthToken,
    }),
    [isPending, login, logout, refreshSession, register, session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }

  return context;
}
