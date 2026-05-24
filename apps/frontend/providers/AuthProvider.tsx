"use client";

import type React from "react";
import { useRouter } from "next/navigation";
import { getUserRoles, hasRole } from "@kiwi/auth/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
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
    isSystemAdmin: boolean;
    isPending: boolean;
    signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

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
    const prevUserIdRef = useRef<string | null>(null);
    const { data: liveSession, isPending } = authClient.useSession();
    const { data: activeMemberRole, isPending: isRolePending } = authClient.useActiveMemberRole();

    const sessionUser = liveSession?.user ?? initialSession.user;
    const systemRoles = getUserRoles(sessionUser?.role ?? null);
    const organizationRoles = getUserRoles(activeMemberRole?.role ?? null);
    const isSystemAdmin = hasRole(sessionUser?.role ?? null, "admin");
    const role = isSystemAdmin ? "admin" : (organizationRoles[0] ?? null);
    const isAdmin = isSystemAdmin || organizationRoles.includes("admin");
    const isManager = systemRoles.includes("manager");
    const pending = isPending || (!!sessionUser && isRolePending);

    useEffect(() => {
        if (!isPending && !liveSession) {
            router.refresh();
        }
    }, [isPending, liveSession, router]);

    useEffect(() => {
        if (sessionUser?.id && prevUserIdRef.current && sessionUser.id !== prevUserIdRef.current) {
            localStorage.removeItem("kiwi-navigation-state");
        }

        prevUserIdRef.current = sessionUser?.id ?? null;
    }, [sessionUser?.id]);

    const signOut = useCallback(async () => {
        await authClient.signOut();
        queryClient.clear();
        localStorage.removeItem("kiwi-navigation-state");
        router.replace("/login");
    }, [authClient, queryClient, router]);

    const value = useMemo<AuthContextType>(
        () => ({
            user: sessionUser
                ? {
                      id: sessionUser.id,
                      name: sessionUser.name,
                      email: sessionUser.email,
                      role: role ?? "member",
                  }
                : null,
            role,
            isAdmin,
            isManager,
            isSystemAdmin,
            isPending: pending,
            signOut,
        }),
        [sessionUser, role, isAdmin, isManager, isSystemAdmin, pending, signOut]
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
