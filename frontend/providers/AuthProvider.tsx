"use client";

import type React from "react";

import { AuthPage } from "@/components/auth";
import { authClient, clearTokenCache, getToken } from "@/lib/auth-client";
import {
  admin as adminRole,
  manager as managerRole,
  user as userRole,
} from "@/lib/auth-permissions";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";

type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: string;
};

type AuthContextType = {
  user: AuthUser | null;
  role: string | null;
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

  // Clear navigation state when a different user logs in
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (user?.id && prevUserIdRef.current && user.id !== prevUserIdRef.current) {
      localStorage.removeItem("kiwi-navigation-state");
    }
    prevUserIdRef.current = user?.id ?? null;
  }, [user?.id]);

  const isAdmin = role === "admin";
  const isManager = role === "manager";

  const roleMap: Record<string, { statements: Record<string, readonly string[]> }> = {
    admin: adminRole,
    manager: managerRole,
    user: userRole,
  };

  const hasPermission = (permission: string): boolean => {
    if (isAdmin) return true;
    const [resource, action] = permission.split(".");
    const roleObj = roleMap[role ?? "user"];
    return roleObj?.statements[resource]?.includes(action) ?? false;
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    clearTokenCache();
    queryClient.clear();
    localStorage.removeItem("kiwi-navigation-state");
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
