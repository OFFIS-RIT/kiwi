"use client";

import { ProjectChat } from "@/components/chat";
import { AppSidebarInset } from "@/components/common";
import { GroupList } from "@/components/groups";
import { BreadcrumbNav, CreateActions, LanguageSwitcher, UserNav } from "@/components/header";
import { ProjectList } from "@/components/projects";
import { AppSidebar } from "@/components/sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { AppProviders, useData, useLanguage, useNavigation } from "@/providers";
import type { Group, Project } from "@/types";
import { Suspense, lazy, useEffect, useRef, useState } from "react";

const DeleteGroupDialog = lazy(() =>
    import("@/components/groups").then((mod) => ({
        default: mod.DeleteGroupDialog,
    }))
);
const DeleteProjectDialog = lazy(() =>
    import("@/components/projects").then((mod) => ({
        default: mod.DeleteProjectDialog,
    }))
);
const EditGroupDialog = lazy(() =>
    import("@/components/groups").then((mod) => ({
        default: mod.EditGroupDialog,
    }))
);
const EditProjectDialog = lazy(() =>
    import("@/components/projects").then((mod) => ({
        default: mod.EditProjectDialog,
    }))
);

type DeletingProjectState = {
    project: Project;
    groupId: string;
    groupName: string;
};

function isProjectProcessing(project: Project): boolean {
    return (
        project.state !== "ready" ||
        (project.processPercentage !== undefined && project.processPercentage >= 0 && project.processPercentage < 100)
    );
}

function DashboardContent() {
    const { selectedGroup, selectedProject, showAllGroups, showGroups, selectItem } = useNavigation();
    const { t } = useLanguage();
    const { groups, isLoading } = useData();
    const [headerReady, setHeaderReady] = useState(false);
    const processingGroupIdsRef = useRef<Set<string>>(new Set());
    const processingProjectIdsRef = useRef<Set<string>>(new Set());
    const processingProjectGroupIdsRef = useRef<Map<string, string>>(new Map());

    useEffect(() => {
        if (!isLoading) {
            requestAnimationFrame(() => setHeaderReady(true));
        }
    }, [isLoading]);

    // Processing graphs can be temporarily absent during polling; avoid treating that as deletion.
    useEffect(() => {
        const processingGroupIds = processingGroupIdsRef.current;
        const processingProjectIds = processingProjectIdsRef.current;
        const processingProjectGroupIds = processingProjectGroupIdsRef.current;

        for (const group of groups) {
            for (const project of group.projects) {
                if (isProjectProcessing(project)) {
                    processingProjectIds.add(project.id);
                    processingProjectGroupIds.set(project.id, group.id);
                } else {
                    processingProjectIds.delete(project.id);
                    processingProjectGroupIds.delete(project.id);
                }
            }
        }

        processingGroupIds.clear();
        for (const groupId of processingProjectGroupIds.values()) {
            processingGroupIds.add(groupId);
        }
    }, [groups]);

    // Redirect when selected group/project was deleted.
    useEffect(() => {
        if (isLoading) return;
        if (selectedGroup) {
            const group = groups.find((g) => g.id === selectedGroup.id);
            if (!group) {
                if (processingGroupIdsRef.current.has(selectedGroup.id)) return;
                showGroups();
                return;
            }
            if (selectedProject && !group.projects.some((p) => p.id === selectedProject.id)) {
                if (processingProjectIdsRef.current.has(selectedProject.id)) return;
                selectItem(group);
            }
        }
    }, [selectedGroup, selectedProject, groups, isLoading, showGroups, selectItem]);

    const [editProjectDialogOpen, setEditProjectDialogOpen] = useState(false);
    const [editGroupDialogOpen, setEditGroupDialogOpen] = useState(false);
    const [editingProject, setEditingProject] = useState<{
        id: string;
        name: string;
        groupId: string;
    } | null>(null);
    const [editingGroup, setEditingGroup] = useState<Group | null>(null);

    const handleEditProject = (project: Project, groupId: string) => {
        setEditingProject({ ...project, groupId });
        setEditProjectDialogOpen(true);
    };

    const handleEditGroup = (group: Group) => {
        setEditingGroup(group);
        setEditGroupDialogOpen(true);
    };

    return (
        <>
            <AppSidebarInset>
                <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b px-4">
                    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                        <SidebarTrigger className="-ml-1" />
                        <Separator orientation="vertical" className="mr-2 h-4 shrink-0" />
                        <BreadcrumbNav ready={headerReady} />
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <LanguageSwitcher />
                        <CreateActions />
                        <UserNav />
                    </div>
                </header>
                <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden p-4">
                    {selectedProject && selectedGroup ? (
                        <div className="h-full min-w-0 overflow-hidden">
                            <ProjectChat
                                projectName={selectedProject.name}
                                groupName={selectedGroup.name}
                                projectId={selectedProject.id}
                            />
                        </div>
                    ) : selectedGroup ? (
                        <div className="h-full overflow-y-auto">
                            <ProjectList onEditProject={handleEditProject} />
                        </div>
                    ) : showAllGroups ? (
                        <div className="h-full overflow-y-auto">
                            <GroupList onEditGroup={handleEditGroup} />
                        </div>
                    ) : (
                        <div className="flex h-full items-center justify-center">
                            <div className="text-center">
                                <h2 className="text-xl font-semibold">{t("no.group.selected")}</h2>
                                <p className="text-muted-foreground">{t("select.group.sidebar")}</p>
                            </div>
                        </div>
                    )}
                </div>
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
        </>
    );
}

type NavigationWrapperProps = {
    onEditGroup: (group: Group) => void;
    onEditProject: (project: Project, groupId: string) => void;
    onDeleteGroup: (group: Group) => void;
    onDeleteProject: (project: Project, groupId: string, groupName: string) => void;
};

function NavigationWrapper({ onEditGroup, onEditProject, onDeleteGroup, onDeleteProject }: NavigationWrapperProps) {
    const { selectItem } = useNavigation();
    const { groups } = useData();

    const handleProjectCreated = (_projectId: string, groupId: string, _projectName: string) => {
        const group = groups.find((g) => g.id === groupId);
        if (group) {
            // Select only the group to show the Project Overview (ProjectList)
            // This allows the user to see the processing status of the new project
            selectItem(group);
        }
    };

    return (
        <AppSidebar
            onEditGroup={onEditGroup}
            onEditProject={onEditProject}
            onDeleteGroup={onDeleteGroup}
            onDeleteProject={onDeleteProject}
            onProjectCreated={handleProjectCreated}
        />
    );
}

function Dashboard() {
    const [editProjectDialogOpen, setEditProjectDialogOpen] = useState(false);
    const [editGroupDialogOpen, setEditGroupDialogOpen] = useState(false);
    const [deleteProjectDialogOpen, setDeleteProjectDialogOpen] = useState(false);
    const [deleteGroupDialogOpen, setDeleteGroupDialogOpen] = useState(false);
    const [editingProject, setEditingProject] = useState<{
        id: string;
        name: string;
        groupId: string;
    } | null>(null);
    const [editingGroup, setEditingGroup] = useState<Group | null>(null);
    const [deletingProject, setDeletingProject] = useState<DeletingProjectState | null>(null);
    const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);

    const handleEditProject = (project: Project, groupId: string) => {
        setEditingProject({ ...project, groupId });
        setEditProjectDialogOpen(true);
    };

    const handleEditGroup = (group: Group) => {
        setEditingGroup(group);
        setEditGroupDialogOpen(true);
    };

    const handleDeleteGroup = (group: Group) => {
        setDeletingGroup(group);
        setDeleteGroupDialogOpen(true);
    };

    const handleDeleteProject = (project: Project, groupId: string, groupName: string) => {
        setDeletingProject({ project, groupId, groupName });
        setDeleteProjectDialogOpen(true);
    };

    return (
        <>
            <NavigationWrapper
                onEditGroup={handleEditGroup}
                onEditProject={handleEditProject}
                onDeleteGroup={handleDeleteGroup}
                onDeleteProject={handleDeleteProject}
            />
            <DashboardContent />

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

export default function Page() {
    return (
        <AppProviders defaultTheme="light">
            <Dashboard />
        </AppProviders>
    );
}
