"use client";

import { AppSidebarInset } from "@/components/common/AppSidebarInset";
import { AppSidebarSkeleton } from "@/components/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Globe, Plus } from "lucide-react";

export function DashboardSkeleton() {
    return (
        <>
            <AppSidebarSkeleton />
            <AppSidebarInset>
                <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b px-4">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                        <SidebarTrigger className="-ml-1" />
                        <Separator orientation="vertical" className="mr-2 h-4" />
                        <Breadcrumb>
                            <BreadcrumbList>
                                <BreadcrumbItem>
                                    <BreadcrumbLink href="#">KIWI</BreadcrumbLink>
                                </BreadcrumbItem>
                            </BreadcrumbList>
                        </Breadcrumb>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                            <Globe className="h-5 w-5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                            <Plus className="h-5 w-5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                            <Avatar className="h-8 w-8">
                                <AvatarFallback />
                            </Avatar>
                        </Button>
                    </div>
                </header>
                <div className="flex-1 p-4" />
            </AppSidebarInset>
        </>
    );
}
