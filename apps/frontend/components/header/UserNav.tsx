"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/providers/AuthProvider";
import { useTranslations } from "next-intl";
import { ApiKeySheet } from "@/components/api-keys";
import { Key, LogOut, Shield } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

const UserManagementSheet = lazy(() =>
    import("@/components/admin").then((mod) => ({
        default: mod.UserManagementSheet,
    }))
);

export function UserNav() {
    const t = useTranslations();
    const { user, isAdmin, signOut } = useAuth();
    const [showUserManagement, setShowUserManagement] = useState(false);
    const [showApiKeys, setShowApiKeys] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        if (user) {
            requestAnimationFrame(() => setReady(true));
        }
    }, [user]);

    const initials = user?.name
        ? user.name
              .split(" ")
              .map((name) => name[0])
              .join("")
              .toUpperCase()
              .slice(0, 2)
        : "?";

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                        <Avatar className="h-8 w-8">
                            <AvatarFallback>
                                <span
                                    className={`transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-0"}`}
                                >
                                    {initials}
                                </span>
                            </AvatarFallback>
                        </Avatar>
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuLabel>{user?.name}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <ThemeToggle />
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setShowApiKeys(true)}>
                        <Key className="h-4 w-4" />
                        <span>{t("apiKey.management")}</span>
                    </DropdownMenuItem>
                    {isAdmin && (
                        <DropdownMenuItem onSelect={() => setShowUserManagement(true)}>
                            <Shield className="h-4 w-4" />
                            <span>{t("admin.user.management")}</span>
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => void signOut()}>
                        <LogOut className="h-4 w-4" />
                        <span>{t("auth.sign.out")}</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <ApiKeySheet open={showApiKeys} onOpenChange={setShowApiKeys} />
            {isAdmin && (
                <Suspense fallback={null}>
                    <UserManagementSheet open={showUserManagement} onOpenChange={setShowUserManagement} />
                </Suspense>
            )}
        </>
    );
}
