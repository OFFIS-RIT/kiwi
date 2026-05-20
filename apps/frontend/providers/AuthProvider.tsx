"use client";

import type React from "react";
import { useRouter } from "next/navigation";
import {
    admin as adminRole,
    getUserRoles,
    hasRole,
    manager as managerRole,
    user as userRole,
} from "@kiwi/auth/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import type { InitialClientSession } from "@/lib/auth/types";
import { useAuthClient } from "./AuthClientProvider";

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
    hasPermission: (permission: string) => boolean;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const roleMap: Record<string, { statements: Record<string, readonly string[]> }> = {
    admin: adminRole,
    manager: managerRole,
    user: userRole,
};

export function AuthProvider({
    initialSession,
    children,
}: {
    initialSession: InitialClientSession;
    children: React.ReactNode;
}) {
    const authClient = useAuthClient();
    const queryClient = useQueryClient();
    const router = useRouter();
    const { data: liveSession, isPending } = authClient.useSession();

    // Pending: SSR-Wert nutzen. Resolved: live ist Source-of-Truth (auch null).
    const sessionUser = isPending ? initialSession.user : (liveSession?.user ?? null);

    // Wenn nach Pending keine Session mehr da ist -> Server-Layout neu evaluieren,
    // das redirected dann zu /login. Verhindert "App ist sichtbar, aber Backend gibt 401".
    useEffect(() => {
        if (!isPending && !liveSession) {
            router.refresh();
        }
    }, [isPending, liveSession, router]);

    const roles = getUserRoles(sessionUser?.role ?? null);
    const role = roles[0] ?? null;
    const isAdmin = hasRole(sessionUser?.role ?? null, "admin");
    const isManager = hasRole(sessionUser?.role ?? null, "manager");

    const hasPermission = useCallback(
        (permission: string): boolean => {
            if (isAdmin) return true;
            const [resource, action] = permission.split(".");
            if (!resource || !action) return false;
            return roles.some((r) => roleMap[r]?.statements[resource]?.includes(action) ?? false);
        },
        [isAdmin, roles]
    );

    const signOut = useCallback(async () => {
        await authClient.signOut();
        queryClient.clear();
        router.replace("/login");
        router.refresh();
    }, [authClient, queryClient, router]);

    const value = useMemo<AuthContextType>(
        () => ({
            user: sessionUser
                ? {
                      id: sessionUser.id,
                      name: sessionUser.name,
                      email: sessionUser.email,
                      role: role ?? "user",
                  }
                : null,
            role,
            isAdmin,
            isManager,
            isPending,
            signOut,
            hasPermission,
        }),
        [sessionUser, role, isAdmin, isManager, isPending, signOut, hasPermission]
    );

    // Nach Pending ohne Session: nichts rendern bis refresh durchgreift.
    // Sicherheits-Boundary ist das Server-Layout; das hier ist UX-Glue.
    if (!isPending && !sessionUser) return null;

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
