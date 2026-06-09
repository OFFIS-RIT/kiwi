"use client";

import { AppSidebarInset } from "@/components/common/AppSidebarInset";
import { AppHeader } from "@/components/common/AppHeader";
import { AppSidebar } from "@/components/sidebar";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import { recordLastAppPath } from "@/lib/last-app-path";
import { SettingsProvider } from "@/providers/SettingsProvider";
import type { Group, Project } from "@/types";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";

const DeleteGroupDialog = lazy(() => import("@/components/groups").then((mod) => ({ default: mod.DeleteGroupDialog })));
const DeleteProjectDialog = lazy(() =>
    import("@/components/projects").then((mod) => ({ default: mod.DeleteProjectDialog }))
);
const EditGroupDialog = lazy(() => import("@/components/groups").then((mod) => ({ default: mod.EditGroupDialog })));
const EditProjectDialog = lazy(() =>
    import("@/components/projects").then((mod) => ({ default: mod.EditProjectDialog }))
);

type DeletingProjectState = {
    project: Project;
    groupId: string;
    groupName: string;
};

type DashboardFrameProps = {
    children: ReactNode;
};

export function DashboardFrame({ children }: DashboardFrameProps) {
    const router = useRouter();
    const pathname = usePathname();
    const isSettings = pathname === "/settings";
    const [editProjectDialogOpen, setEditProjectDialogOpen] = useState(false);
    const [editGroupDialogOpen, setEditGroupDialogOpen] = useState(false);
    const [deleteProjectDialogOpen, setDeleteProjectDialogOpen] = useState(false);
    const [deleteGroupDialogOpen, setDeleteGroupDialogOpen] = useState(false);
    const [editingProject, setEditingProject] = useState<{ id: string; name: string; groupId: string } | null>(null);
    const [editingGroup, setEditingGroup] = useState<Group | null>(null);
    const [deletingProject, setDeletingProject] = useState<DeletingProjectState | null>(null);
    const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);

    useEffect(() => {
        recordLastAppPath(pathname);
    }, [pathname]);

    const handleEditProject = (project: Project, groupId: string) => {
        setEditingProject({ ...project, groupId });
        setEditProjectDialogOpen(true);
    };

    const handleEditGroup = (group: Group) => {
        setEditingGroup(group);
        setEditGroupDialogOpen(true);
    };

    if (isSettings) {
        return (
            <Suspense fallback={null}>
                <SettingsProvider>
                    <SettingsSidebar />
                    <AppSidebarInset>
                        <AppHeader />
                        <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden p-4">{children}</div>
                    </AppSidebarInset>
                </SettingsProvider>
            </Suspense>
        );
    }

    return (
        <>
            <AppSidebar
                onEditGroup={handleEditGroup}
                onEditProject={handleEditProject}
                onDeleteGroup={(group) => {
                    setDeletingGroup(group);
                    setDeleteGroupDialogOpen(true);
                }}
                onDeleteProject={(project, groupId, groupName) => {
                    setDeletingProject({ project, groupId, groupName });
                    setDeleteProjectDialogOpen(true);
                }}
                onProjectCreated={(_projectId, groupId) => router.push(`/${groupId}`)}
            />
            <AppSidebarInset>
                <AppHeader />
                <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden p-4">{children}</div>
            </AppSidebarInset>

            <Suspense fallback={null}>
                <EditProjectDialog
                    open={editProjectDialogOpen}
                    onOpenChange={setEditProjectDialogOpen}
                    project={editingProject}
                    groupId={editingProject?.groupId || null}
                />
            </Suspense>
            <Suspense fallback={null}>
                <EditGroupDialog
                    open={editGroupDialogOpen}
                    onOpenChange={setEditGroupDialogOpen}
                    group={editingGroup}
                />
            </Suspense>
            <Suspense fallback={null}>
                <DeleteProjectDialog
                    open={deleteProjectDialogOpen}
                    onOpenChange={setDeleteProjectDialogOpen}
                    project={deletingProject?.project || null}
                    groupId={deletingProject?.groupId || null}
                    groupName={deletingProject?.groupName || null}
                />
            </Suspense>
            <Suspense fallback={null}>
                <DeleteGroupDialog
                    open={deleteGroupDialogOpen}
                    onOpenChange={setDeleteGroupDialogOpen}
                    group={deletingGroup}
                />
            </Suspense>
        </>
    );
}
