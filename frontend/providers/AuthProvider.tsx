"use client";

import type { ReactNode } from "react";
import {
    createContext,
    useContext,
    useCallback,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    authClient,
    signIn,
    signUp,
    signOut,
    useSession,
} from "@/lib/auth-client";

type User = {
    id: string;
    name: string;
    email: string;
    role?: string;
};

type AuthContextType = {
    user: User | null;
    isLoading: boolean;
    isAuthenticated: boolean;
    signIn: typeof signIn;
    signUp: typeof signUp;
    signOut: typeof signOut;
    getToken: () => Promise<string | null>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const { data: session, isPending } = useSession();
    const [cachedToken, setCachedToken] = useState<string | null>(null);
    const tokenExpiryRef = useRef<number>(0);

    const getToken = useCallback(async () => {
        const now = Date.now();
        // Token noch gültig? (5 Min Buffer vor Ablauf)
        if (cachedToken && tokenExpiryRef.current > now + 5 * 60 * 1000) {
            return cachedToken;
        }
        try {
            const { data, error } = await authClient.token();
            if (error || !data?.token) return null;
            setCachedToken(data.token);
            tokenExpiryRef.current = now + 15 * 60 * 1000; // 15 Min default
            return data.token;
        } catch {
            return null;
        }
    }, [cachedToken]);

    const value = useMemo<AuthContextType>(
        () => ({
            user: session?.user ?? null,
            isLoading: isPending,
            isAuthenticated: !!session?.user,
            signIn,
            signUp,
            signOut,
            getToken,
        }),
        [session, isPending, getToken]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) throw new Error("useAuth must be used within AuthProvider");
    return context;
}
