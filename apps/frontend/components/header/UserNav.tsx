"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { queryKeys } from "@/lib/query-keys";
import { useAuthClient } from "@/providers/AuthClientProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Check, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

export function UserNav() {
    const t = useAppTranslations();
    const authClient = useAuthClient();
    const queryClient = useQueryClient();
    const { user, signOut } = useAuth();
    const { data: organizations } = authClient.useListOrganizations();
    const { data: activeOrganization } = authClient.useActiveOrganization();
    const [ready, setReady] = useState(false);
    const organizationList = organizations ?? [];
    const canSwitchOrganization = organizationList.length > 1;

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

    const handleSwitchOrganization = async (organizationId: string) => {
        if (organizationId === activeOrganization?.id) {
            return;
        }

        const { error } = await authClient.organization.setActive({ organizationId });
        if (error) {
            return;
        }

        localStorage.removeItem("kiwi-navigation-state");
        queryClient.removeQueries({ queryKey: queryKeys.groups });
        await queryClient.invalidateQueries();
    };

    return (
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
                {canSwitchOrganization ? (
                    <>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Building2 className="h-4 w-4" />
                                <span>{t("organization.switch")}</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent alignOffset={-4} className="w-56">
                                {organizationList.map((organization) => (
                                    <DropdownMenuItem
                                        key={organization.id}
                                        onSelect={() => void handleSwitchOrganization(organization.id)}
                                    >
                                        <span className="truncate">{organization.name}</span>
                                        {organization.id === activeOrganization?.id ? (
                                            <Check className="ml-auto h-4 w-4" />
                                        ) : null}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                    </>
                ) : null}
                <DropdownMenuItem asChild>
                    <Link href="/settings">
                        <Settings className="h-4 w-4" />
                        <span>{t("settings")}</span>
                    </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void signOut()}>
                    <LogOut className="h-4 w-4" />
                    <span>{t("auth.sign.out")}</span>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
