"use client";

import type React from "react";
import { useRouter } from "next/navigation";
import { getUserRoles, hasRole } from "@kiwi/auth/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
    isSystemAdmin: boolean;
    isAuthenticated: boolean;
    isPending: boolean;
    isSigningOut: boolean;
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
    const [isSigningOut, setIsSigningOut] = useState(false);
    const { data: liveSession, isPending } = authClient.useSession();
    const { data: activeMemberRole, isPending: isRolePending } = authClient.useActiveMemberRole();

    const initialUser = initialSession.user.id ? initialSession.user : null;
    const isSignedOut = !isPending && !liveSession;
    const sessionUser = isSigningOut || isSignedOut ? null : (liveSession?.user ?? initialUser);
    const organizationRoles = getUserRoles(activeMemberRole?.role ?? null);
    const isSystemAdmin = hasRole(sessionUser?.role ?? null, "admin");
    const role = isSystemAdmin ? "admin" : (organizationRoles[0] ?? null);
    const isAdmin = isSystemAdmin || organizationRoles.includes("admin");
    const isAuthenticated = !!sessionUser && !isSigningOut;
    const pending = !isSigningOut && (isPending || (!!sessionUser && isRolePending));

    useEffect(() => {
        if (!isPending && !liveSession && !isSigningOut) {
            router.refresh();
        }
    }, [isPending, isSigningOut, liveSession, router]);

    useEffect(() => {
        if (sessionUser?.id && prevUserIdRef.current && sessionUser.id !== prevUserIdRef.current) {
            localStorage.removeItem("kiwi-navigation-state");
        }

        prevUserIdRef.current = sessionUser?.id ?? null;
    }, [sessionUser?.id]);

    const signOut = useCallback(async () => {
        setIsSigningOut(true);
        await queryClient.cancelQueries();
        queryClient.clear();
        localStorage.removeItem("kiwi-navigation-state");
        try {
            await authClient.signOut();
            router.replace("/login");
        } catch (error) {
            setIsSigningOut(false);
            throw error;
        }
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
            isSystemAdmin,
            isAuthenticated,
            isPending: pending,
            isSigningOut,
            signOut,
        }),
        [sessionUser, role, isAdmin, isSystemAdmin, isAuthenticated, pending, isSigningOut, signOut]
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
