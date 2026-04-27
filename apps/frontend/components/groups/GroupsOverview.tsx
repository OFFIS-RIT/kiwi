"use client";

import { AppSidebarInset } from "@/components/common/AppSidebarInset";
import { BreadcrumbNav } from "@/components/header/BreadcrumbNav";
import { CreateActions } from "@/components/header/CreateActions";
import { LanguageSwitcher } from "@/components/header/LanguageSwitcher";
import { UserNav } from "@/components/header/UserNav";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { Group } from "@/types";
import { Suspense, lazy, useState } from "react";
import { GroupList } from "./GroupList";

const EditGroupDialog = lazy(() =>
    import("@/components/groups/EditGroupDialog").then((mod) => ({ default: mod.EditGroupDialog }))
);

export function GroupsOverview() {
    const [editGroupDialogOpen, setEditGroupDialogOpen] = useState(false);
    const [editingGroup, setEditingGroup] = useState<Group | null>(null);

    const handleEditGroup = (group: Group) => {
        setEditingGroup(group);
        setEditGroupDialogOpen(true);
    };

    return (
        <AppSidebarInset>
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
            <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden p-4">
                <div className="h-full overflow-y-auto">
                    <GroupList onEditGroup={handleEditGroup} />
                </div>
            </div>

            <Suspense fallback={null}>
                <EditGroupDialog
                    open={editGroupDialogOpen}
                    onOpenChange={setEditGroupDialogOpen}
                    group={editingGroup}
                />
            </Suspense>
        </AppSidebarInset>
    );
}
