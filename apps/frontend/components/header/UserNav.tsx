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
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { LogOut, Settings, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

export function UserNav() {
    const t = useAppTranslations();
    const { user, isAdmin, signOut } = useAuth();
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
                    <DropdownMenuItem asChild>
                        <Link href="/settings">
                            <Settings className="h-4 w-4" />
                            <span>{t("settings")}</span>
                        </Link>
                    </DropdownMenuItem>
                    {isAdmin && (
                        <DropdownMenuItem asChild>
                            <Link href="/admin">
                                <ShieldCheck className="h-4 w-4" />
                                <span>{t("admin.role.admin")}</span>
                            </Link>
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => void signOut()}>
                        <LogOut className="h-4 w-4" />
                        <span>{t("auth.sign.out")}</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}
