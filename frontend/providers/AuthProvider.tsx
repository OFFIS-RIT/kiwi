"use client";

import type React from "react";

import { AuthPage } from "@/components/auth";
import { authClient, clearTokenCache, getToken } from "@/lib/auth-client";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState } from "react";

type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: string;
};

type AuthContextType = {
  user: AuthUser | null;
  role: string | null;
  permissions: string[];
  isAdmin: boolean;
  isManager: boolean;
  isPending: boolean;
  signOut: () => Promise<void>;
  getToken: () => Promise<string>;
  hasPermission: (permission: string) => boolean;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const queryClient = useQueryClient();
  const [authView, setAuthView] = useState<"login" | "register">("login");

  const user = session?.user ?? null;
  const role = (user as any)?.role ?? null;

  const permissions = useMemo(() => {
    if (!session?.user) return [];
    return (session.user as any).permissions ?? [];
  }, [session]);

  const isAdmin = role === "admin";
  const isManager = role === "manager";

  const hasPermission = (permission: string): boolean => {
    if (isAdmin) return true;
    return permissions.includes(permission);
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    clearTokenCache();
    queryClient.clear();
  };

  const value: AuthContextType = {
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          role: (user as any).role ?? "user",
        }
      : null,
    role,
    permissions,
    isAdmin,
    isManager,
    isPending,
    signOut: handleSignOut,
    getToken,
    hasPermission,
  };

  if (isPending) {
    return (
      <AuthContext.Provider value={value}>
        <div className="flex min-h-screen items-center justify-center">
          <div className="animate-pulse text-muted-foreground">Loading...</div>
        </div>
      </AuthContext.Provider>
    );
  }

  if (!session) {
    return (
      <AuthContext.Provider value={value}>
        <AuthPage view={authView} onViewChange={setAuthView} />
      </AuthContext.Provider>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
