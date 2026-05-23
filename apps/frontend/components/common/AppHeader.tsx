"use client";

import { BreadcrumbNav, CreateActions, LanguageSwitcher, UserNav } from "@/components/header";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function AppHeader() {
    return (
        <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                <SidebarTrigger className="-ml-1" />
                <Separator orientation="vertical" className="mr-2 h-4 shrink-0" />
                <BreadcrumbNav />
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <LanguageSwitcher />
                <CreateActions />
                <UserNav />
            </div>
        </header>
    );
}
