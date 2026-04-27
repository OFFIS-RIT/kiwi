"use client";

import { AppSidebarInset } from "@/components/common/AppSidebarInset";
import { BreadcrumbNav } from "@/components/header/BreadcrumbNav";
import { CreateActions } from "@/components/header/CreateActions";
import { LanguageSwitcher } from "@/components/header/LanguageSwitcher";
import { UserNav } from "@/components/header/UserNav";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { Project } from "@/types";
import { Suspense, lazy, useState } from "react";
import { ProjectList } from "./ProjectList";

const EditProjectDialog = lazy(() =>
    import("@/components/projects/EditProjectDialog").then((mod) => ({ default: mod.EditProjectDialog }))
);

type ProjectListViewProps = {
    groupName: string;
};

export function ProjectListView({ groupName }: ProjectListViewProps) {
    const [editProjectDialogOpen, setEditProjectDialogOpen] = useState(false);
    const [editingProject, setEditingProject] = useState<{
        id: string;
        name: string;
        groupId: string;
    } | null>(null);

    const handleEditProject = (project: Project, projectGroupId: string) => {
        setEditingProject({ ...project, groupId: projectGroupId });
        setEditProjectDialogOpen(true);
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
                    <ProjectList groupName={groupName} onEditProject={handleEditProject} />
                </div>
            </div>

            <Suspense fallback={null}>
                <EditProjectDialog
                    open={editProjectDialogOpen}
                    onOpenChange={setEditProjectDialogOpen}
                    project={editingProject}
                    groupId={editingProject?.groupId || null}
                />
            </Suspense>
        </AppSidebarInset>
    );
}
