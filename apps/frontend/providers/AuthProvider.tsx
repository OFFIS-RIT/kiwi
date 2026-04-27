"use client";

import type React from "react";

import { authClient } from "@kiwi/auth/client";
import {
    admin as adminRole,
    getUserRoles,
    hasRole,
    manager as managerRole,
    user as userRole,
} from "@kiwi/auth/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useContext } from "react";

type AuthUser = {
    id: string;
    name: string;
    email: string;
    role: string;
};

type AuthContextType = {
    user: AuthUser;
    role: string;
    authMode: string;
    isAdmin: boolean;
    isManager: boolean;
    signOut: () => Promise<void>;
    hasPermission: (permission: string) => boolean;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

type AuthProviderProps = {
    initialSession: {
        user: { id: string; name: string; email: string; role: string };
    };
    authMode: string;
    children: React.ReactNode;
};

export function AuthProvider({ initialSession, authMode, children }: AuthProviderProps) {
    const queryClient = useQueryClient();
    const router = useRouter();

    const user = initialSession.user;
    const roles = getUserRoles(user.role ?? null);
    const role = roles[0] ?? "user";

    const isAdmin = hasRole(user.role ?? null, "admin");
    const isManager = hasRole(user.role ?? null, "manager");

    const roleMap: Record<string, { statements: Record<string, readonly string[]> }> = {
        admin: adminRole,
        manager: managerRole,
        user: userRole,
    };

    const hasPermission = (permission: string): boolean => {
        if (isAdmin) return true;

        const [resource, action] = permission.split(".");
        if (!resource || !action) return false;

        return roles.some((currentRole) => roleMap[currentRole]?.statements[resource]?.includes(action) ?? false);
    };

    const handleSignOut = async () => {
        await authClient.signOut();
        queryClient.clear();
        router.push("/login");
    };

    const value: AuthContextType = {
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role,
        },
        role,
        authMode,
        isAdmin,
        isManager,
        signOut: handleSignOut,
        hasPermission,
    };

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
