"use client";

import { Button } from "@/components/ui/button";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/providers/LanguageProvider";
import { Search } from "lucide-react";
import Image from "next/image";
import type * as React from "react";

export function AppSidebarSkeleton(props: React.ComponentProps<typeof Sidebar>) {
    const { t } = useLanguage();

    return (
        <Sidebar {...props}>
            <SidebarHeader>
                <div className="flex items-center justify-between p-2">
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton size="lg">
                                <div className="flex aspect-square size-8 items-center justify-center rounded-lg overflow-hidden">
                                    <Image
                                        src="/KIWI.jpg"
                                        alt="KIWI"
                                        width={48}
                                        height={48}
                                        unoptimized
                                        className="size-full object-cover"
                                    />
                                </div>
                                <div className="grid flex-1 text-left text-sm leading-tight">
                                    <span className="truncate font-semibold">KIWI</span>
                                    <span className="truncate text-xs">OFFIS e. V.</span>
                                </div>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    >
                        <Search className="h-4 w-4" />
                        <span className="sr-only">{t("search")}</span>
                    </Button>
                </div>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupLabel>{t("knowledge.groups")}</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {["60%", "75%", "55%", "70%"].map((width, i) => (
                                <SidebarMenuItem key={i}>
                                    <div className="flex h-8 items-center gap-2 rounded-md px-2">
                                        <Skeleton className="size-4 rounded-md" />
                                        <Skeleton className="h-4 flex-1" style={{ maxWidth: width }} />
                                    </div>
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <SidebarRail />
        </Sidebar>
    );
}
