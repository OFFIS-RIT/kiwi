"use client";

import { Button } from "@/components/ui/button";
import type { Group, Project } from "@/types";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInput,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSub,
    SidebarRail,
} from "@/components/ui/sidebar";
import { useData } from "@/providers/DataProvider";
import { useLanguage } from "@/providers/LanguageProvider";
import { useSidebarExpansion } from "@/providers/SidebarExpansionProvider";
import { ProjectProgressChart } from "./ProjectProgressChart";
import Fuse from "fuse.js";
import { BookOpen, ChevronRight, Edit, FolderSearch, MoreVertical, Plus, Search, Trash2, Users, X } from "lucide-react";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import type * as React from "react";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";

const CreateProjectDialog = lazy(() =>
    import("@/components/projects").then((mod) => ({
        default: mod.CreateProjectDialog,
    }))
);
const DeleteGroupDialog = lazy(() =>
    import("@/components/groups/DeleteGroupDialog").then((mod) => ({
        default: mod.DeleteGroupDialog,
    }))
);
const DeleteProjectDialog = lazy(() =>
    import("@/components/projects/DeleteProjectDialog").then((mod) => ({
        default: mod.DeleteProjectDialog,
    }))
);
const EditGroupDialog = lazy(() =>
    import("@/components/groups/EditGroupDialog").then((mod) => ({
        default: mod.EditGroupDialog,
    }))
);
const EditProjectDialog = lazy(() =>
    import("@/components/projects/EditProjectDialog").then((mod) => ({
        default: mod.EditProjectDialog,
    }))
);

type SearchResult = {
    type: "group" | "project";
    group: Group;
    project?: Project;
    score: number;
};

const MIN_SEARCH_LENGTH = 1;

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
    buildLabel?: string;
};

export function AppSidebar({ buildLabel, ...props }: AppSidebarProps) {
    const { t } = useLanguage();
    const { groups, isLoading, error } = useData();
    const pathname = usePathname();
    const router = useRouter();

    const segments = pathname.split("/").filter(Boolean);
    const activeGroupName = segments[0] ? decodeURIComponent(segments[0]) : null;
    const activeProjectName = segments[1] ? decodeURIComponent(segments[1]) : null;

    // Dialog state
    const [editGroupDialogOpen, setEditGroupDialogOpen] = useState(false);
    const [editingGroup, setEditingGroup] = useState<Group | null>(null);
    const [editProjectDialogOpen, setEditProjectDialogOpen] = useState(false);
    const [editingProject, setEditingProject] = useState<{ id: string; name: string; groupId: string } | null>(null);
    const [deleteGroupDialogOpen, setDeleteGroupDialogOpen] = useState(false);
    const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);
    const [deleteProjectDialogOpen, setDeleteProjectDialogOpen] = useState(false);
    const [deletingProject, setDeletingProject] = useState<{ project: Project; groupId: string; groupName: string } | null>(null);

    const handleEditGroup = (group: Group) => {
        setEditingGroup(group);
        setEditGroupDialogOpen(true);
    };
    const handleEditProject = (project: Project, groupId: string) => {
        setEditingProject({ ...project, groupId });
        setEditProjectDialogOpen(true);
    };
    const handleDeleteGroup = (group: Group) => {
        setDeletingGroup(group);
        setDeleteGroupDialogOpen(true);
    };
    const handleDeleteProject = (project: Project, groupId: string, groupName: string) => {
        setDeletingProject({ project, groupId, groupName });
        setDeleteProjectDialogOpen(true);
    };
    const handleProjectCreated = (_projectId: string, groupId: string) => {
        const group = groups.find((g) => g.id === groupId);
        if (group) {
            router.push(`/${encodeURIComponent(group.name)}`);
        }
    };

    const {
        expandedGroups,
        toggleGroupExpanded,
        initializeExpandedGroups,
        restoreExpansionAfterSearch,
        expandGroupsForSearch,
    } = useSidebarExpansion();

    const [showSearch, setShowSearch] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");
    const [ready, setReady] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const originalExpandedStateRef = useRef<Record<string, boolean>>({});
    const projectSelectedDuringSearchRef = useRef(false);
    const wasSearchingRef = useRef(false);
    const selectedGroupIdDuringSearchRef = useRef<string | null>(null);
    const expandedGroupsRef = useRef(expandedGroups);

    // Build flat list for Fuse.js search
    const searchableItems = useMemo(() => {
        const items: Array<{
            type: "group" | "project";
            name: string;
            group: Group;
            project?: Project;
        }> = [];

        groups.forEach((group) => {
            items.push({ type: "group", name: group.name, group });
            group.projects.forEach((project) => {
                items.push({ type: "project", name: project.name, group, project });
            });
        });

        return items;
    }, [groups]);

    // Initialize Fuse.js
    const fuse = useMemo(
        () =>
            new Fuse(searchableItems, {
                keys: ["name"],
                threshold: 0.4, // Allows typos
                distance: 100,
                includeScore: true,
                minMatchCharLength: 1,
            }),
        [searchableItems]
    );

    // Compute search results
    const searchResults = useMemo((): SearchResult[] => {
        if (!searchTerm.trim() || searchTerm.trim().length < MIN_SEARCH_LENGTH) {
            return [];
        }
        const results = fuse.search(searchTerm.trim());
        return results.map((r) => ({
            type: r.item.type,
            group: r.item.group,
            project: r.item.project,
            score: r.score ?? 1,
        }));
    }, [fuse, searchTerm]);

    const isSearching = searchTerm.trim().length >= MIN_SEARCH_LENGTH;

    // Build grouped results for display
    const groupedResults = useMemo(() => {
        if (!isSearching) return null;

        const groupMap = new Map<string, { group: Group; matchedProjects: Set<string>; groupMatches: boolean }>();

        searchResults.forEach((result) => {
            const groupId = result.group.id;
            if (!groupMap.has(groupId)) {
                groupMap.set(groupId, {
                    group: result.group,
                    matchedProjects: new Set(),
                    groupMatches: false,
                });
            }
            const entry = groupMap.get(groupId)!;
            if (result.type === "group") {
                entry.groupMatches = true;
            } else if (result.project) {
                entry.matchedProjects.add(result.project.id);
            }
        });

        return groupMap;
    }, [searchResults, isSearching]);

    useEffect(() => {
        expandedGroupsRef.current = expandedGroups;
    }, [expandedGroups]);

    useEffect(() => {
        if (!isLoading && !error) {
            requestAnimationFrame(() => setReady(true));
        }
    }, [isLoading, error]);

    useEffect(() => {
        if (groups.length > 0) {
            const groupIds = groups.map((group) => group.id);
            initializeExpandedGroups(groupIds);
        }
    }, [groups, initializeExpandedGroups]);

    // Handle expansion state during search
    useEffect(() => {
        if (!isSearching) {
            if (wasSearchingRef.current) {
                if (projectSelectedDuringSearchRef.current && selectedGroupIdDuringSearchRef.current) {
                    const stateToRestore = { ...originalExpandedStateRef.current };
                    stateToRestore[selectedGroupIdDuringSearchRef.current] = true;
                    restoreExpansionAfterSearch(stateToRestore);
                } else {
                    restoreExpansionAfterSearch(originalExpandedStateRef.current);
                }
            }
            wasSearchingRef.current = false;
            return;
        }

        if (!wasSearchingRef.current) {
            originalExpandedStateRef.current = { ...expandedGroupsRef.current };
            projectSelectedDuringSearchRef.current = false;
            selectedGroupIdDuringSearchRef.current = null;
        }
        wasSearchingRef.current = true;

        if (groupedResults) {
            const groupIdsToExpand = Array.from(groupedResults.keys());
            expandGroupsForSearch(groupIdsToExpand);
        }
    }, [isSearching, groupedResults, expandGroupsForSearch, restoreExpansionAfterSearch]);

    useEffect(() => {
        if (isSearching && activeProjectName && activeGroupName) {
            projectSelectedDuringSearchRef.current = true;
            const activeGroup = groups.find((g) => g.name === activeGroupName);
            selectedGroupIdDuringSearchRef.current = activeGroup?.id ?? null;
        }
    }, [isSearching, activeProjectName, activeGroupName, groups]);

    // Focus search input when opened
    useEffect(() => {
        if (showSearch && searchInputRef.current) {
            searchInputRef.current.focus();
        }
    }, [showSearch]);

    const clearSearch = () => {
        setSearchTerm("");
        searchInputRef.current?.focus();
    };

    const toggleSearch = () => {
        if (showSearch) {
            setSearchTerm("");
        }
        setShowSearch(!showSearch);
    };

    // Get groups to display based on search state
    const displayGroups = useMemo(() => {
        if (!isSearching || !groupedResults) return groups;

        return Array.from(groupedResults.values()).map(({ group, matchedProjects, groupMatches }) => ({
            ...group,
            projects: groupMatches ? group.projects : group.projects.filter((p) => matchedProjects.has(p.id)),
            matchedProjectIds: matchedProjects,
            groupMatches,
        }));
    }, [groups, isSearching, groupedResults]);

    return (
        <Sidebar {...props}>
            <SidebarHeader>
                <div className="flex items-center justify-between p-2">
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton size="lg" onClick={() => router.push("/")}>
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
                        className={`h-8 w-8 transition-colors ${
                            showSearch
                                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        }`}
                        onClick={toggleSearch}
                    >
                        <Search className="h-4 w-4" />
                        <span className="sr-only">{t("search")}</span>
                    </Button>
                </div>
                {showSearch && (
                    <div className="px-2 pb-3">
                        <div className="relative">
                            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                            <SidebarInput
                                ref={searchInputRef}
                                placeholder={t("search.placeholder")}
                                className="h-9 bg-sidebar-accent/50 pl-9 pr-8 focus-visible:ring-sidebar-ring"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                            {searchTerm && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-transparent"
                                    onClick={clearSearch}
                                >
                                    <X className="h-3.5 w-3.5" />
                                    <span className="sr-only">{t("clear")}</span>
                                </Button>
                            )}
                        </div>
                        {isSearching && (
                            <div className="mt-2 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                                <span className="inline-flex items-center gap-1">
                                    {searchResults.length > 0 ? (
                                        <>
                                            <span className="font-medium text-foreground">{searchResults.length}</span>{" "}
                                            {t("search.results.found")}
                                        </>
                                    ) : (
                                        t("no.search.results")
                                    )}
                                </span>
                            </div>
                        )}
                    </div>
                )}
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupLabel>{t("knowledge.groups")}</SidebarGroupLabel>
                    <SidebarGroupContent>
                        {error ? (
                            <div className="px-2 py-4 text-center text-sm text-destructive">{error}</div>
                        ) : isSearching && searchResults.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                                <FolderSearch className="h-10 w-10 text-muted-foreground/50 mb-3" />
                                <p className="text-sm font-medium text-muted-foreground">{t("no.search.results")}</p>
                                <p className="text-xs text-muted-foreground/70 mt-1">{t("search.try.different")}</p>
                            </div>
                        ) : !isLoading && groups.length === 0 ? (
                            <div className="px-2 py-4 text-center text-sm text-muted-foreground">{t("no.groups")}</div>
                        ) : groups.length > 0 ? (
                            <ScrollArea className={`h-[calc(100vh-12rem)] transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-0"}`}>
                                <SidebarMenu>
                                    {displayGroups.map((group) => (
                                        <GroupItem
                                            key={group.id}
                                            group={group}
                                            isExpanded={expandedGroups[group.id] ?? false}
                                            activeGroupName={activeGroupName}
                                            activeProjectName={activeProjectName}
                                            onToggleExpanded={() => toggleGroupExpanded(group.id)}
                                            highlightTerm={isSearching ? searchTerm : undefined}
                                            matchedProjectIds={
                                                isSearching && "matchedProjectIds" in group
                                                    ? (group.matchedProjectIds as Set<string>)
                                                    : undefined
                                            }
                                            onSelectProject={(groupId) => {
                                                if (isSearching) {
                                                    projectSelectedDuringSearchRef.current = true;
                                                    selectedGroupIdDuringSearchRef.current = groupId;
                                                }
                                            }}
                                            onEditProject={handleEditProject}
                                            onEditGroup={handleEditGroup}
                                            onDeleteGroup={handleDeleteGroup}
                                            onDeleteProject={handleDeleteProject}
                                            onProjectCreated={handleProjectCreated}
                                        />
                                    ))}
                                </SidebarMenu>
                            </ScrollArea>
                        ) : null}
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            {buildLabel ? (
                <SidebarFooter className="gap-1 border-t border-sidebar-border group-data-[collapsible=icon]:hidden">
                    <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-sidebar-foreground/40">
                        {t("app.build")}
                    </span>
                    <span className="truncate font-mono text-xs text-sidebar-foreground/70" title={buildLabel}>
                        {buildLabel}
                    </span>
                </SidebarFooter>
            ) : null}

            <Suspense fallback={null}>
                <EditGroupDialog open={editGroupDialogOpen} onOpenChange={setEditGroupDialogOpen} group={editingGroup} />
            </Suspense>
            <Suspense fallback={null}>
                <EditProjectDialog open={editProjectDialogOpen} onOpenChange={setEditProjectDialogOpen} project={editingProject} groupId={editingProject?.groupId || null} />
            </Suspense>
            <Suspense fallback={null}>
                <DeleteGroupDialog open={deleteGroupDialogOpen} onOpenChange={setDeleteGroupDialogOpen} group={deletingGroup} />
            </Suspense>
            <Suspense fallback={null}>
                <DeleteProjectDialog open={deleteProjectDialogOpen} onOpenChange={setDeleteProjectDialogOpen} project={deletingProject?.project || null} groupId={deletingProject?.groupId || null} groupName={deletingProject?.groupName || null} />
            </Suspense>

            <SidebarRail />
        </Sidebar>
    );
}

type GroupItemProps = {
    group: Group;
    isExpanded: boolean;
    activeGroupName: string | null;
    activeProjectName: string | null;
    onToggleExpanded: () => void;
    highlightTerm?: string;
    matchedProjectIds?: Set<string>;
    onSelectProject: (groupId: string) => void;
    onEditProject: (project: Project, groupId: string) => void;
    onEditGroup: (group: Group) => void;
    onDeleteGroup: (group: Group) => void;
    onDeleteProject: (project: Project, groupId: string, groupName: string) => void;
    onProjectCreated?: (projectId: string, groupId: string, projectName: string) => void;
};

// Modern highlight: finds best matching substring and highlights it subtly
function fuzzyHighlight(text: string, term: string): React.ReactNode {
    if (!term.trim()) return text;

    const lowerText = text.toLowerCase();
    const lowerTerm = term.toLowerCase().trim();

    // Try exact substring match first
    const exactIndex = lowerText.indexOf(lowerTerm);
    if (exactIndex !== -1) {
        return (
            <>
                {text.slice(0, exactIndex)}
                <span className="font-semibold text-foreground">
                    {text.slice(exactIndex, exactIndex + lowerTerm.length)}
                </span>
                {text.slice(exactIndex + lowerTerm.length)}
            </>
        );
    }

    // Find the best continuous matching region
    let bestStart = -1;
    let bestLength = 0;

    for (let start = 0; start < lowerText.length; start++) {
        let matchLen = 0;
        let ti = 0;
        for (let i = start; i < lowerText.length && ti < lowerTerm.length; i++) {
            if (lowerText[i] === lowerTerm[ti]) {
                matchLen++;
                ti++;
            }
        }
        if (matchLen > bestLength) {
            bestLength = matchLen;
            bestStart = start;
        }
    }

    // If we found a good match region, highlight from start to where most matches end
    if (bestStart !== -1 && bestLength >= Math.min(2, lowerTerm.length)) {
        // Find the end of the matching region
        let endPos = bestStart;
        let ti = 0;
        for (let i = bestStart; i < lowerText.length && ti < lowerTerm.length; i++) {
            if (lowerText[i] === lowerTerm[ti]) {
                ti++;
                endPos = i + 1;
            }
        }

        return (
            <>
                {text.slice(0, bestStart)}
                <span className="font-semibold text-foreground">{text.slice(bestStart, endPos)}</span>
                {text.slice(endPos)}
            </>
        );
    }

    // No good match found, return text as-is
    return text;
}

function GroupItem({
    group,
    isExpanded,
    activeGroupName,
    activeProjectName,
    onToggleExpanded,
    highlightTerm,
    matchedProjectIds,
    onSelectProject,
    onEditProject,
    onEditGroup,
    onDeleteGroup,
    onDeleteProject,
    onProjectCreated,
}: GroupItemProps) {
    const { t } = useLanguage();
    const router = useRouter();
    const [showCreateProject, setShowCreateProject] = useState(false);

    const projectsToShow = group.projects;

    return (
        <SidebarMenuItem>
            <Collapsible className="group/collapsible" open={isExpanded} onOpenChange={onToggleExpanded}>
                <div className="group/group-row relative flex min-w-0 items-center gap-1">
                    <CollapsibleTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0 p-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                            aria-label={isExpanded ? "Gruppe einklappen" : "Gruppe ausklappen"}
                        >
                            <ChevronRight className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                        </Button>
                    </CollapsibleTrigger>
                    <SidebarMenuButton
                        className="min-w-0 flex-1 pr-8"
                        isActive={activeGroupName === group.name && !activeProjectName}
                        onClick={() => router.push(`/${encodeURIComponent(group.name)}`)}
                        title={group.name}
                        tooltip={group.name}
                    >
                        <Users className="shrink-0" />
                        <div className="w-0 min-w-0 flex-1 overflow-hidden">
                            <span className="block truncate">
                                {highlightTerm ? fuzzyHighlight(group.name, highlightTerm) : group.name}
                            </span>
                        </div>
                    </SidebarMenuButton>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                            <SidebarMenuAction className="opacity-0 group-hover/group-row:opacity-100 group-focus-within/group-row:opacity-100 data-[state=open]:opacity-100">
                                <MoreVertical className="h-4 w-4" />
                                <span className="sr-only">{t("options")}</span>
                            </SidebarMenuAction>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" side="right" className="w-48">
                            <DropdownMenuItem onSelect={() => onEditGroup(group)}>
                                <Edit className="mr-2 h-4 w-4" />
                                <span>{t("edit")}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setShowCreateProject(true)}>
                                <Plus className="mr-2 h-4 w-4" />
                                <span>{t("create.new.project")}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onSelect={() => onDeleteGroup(group)}
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                <span>{t("delete")}</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <Suspense fallback={null}>
                    <CreateProjectDialog
                        open={showCreateProject}
                        onOpenChange={setShowCreateProject}
                        groupId={group.id}
                        onProjectCreated={onProjectCreated}
                    />
                </Suspense>
                <CollapsibleContent>
                    <SidebarMenuSub className="mr-0 pr-0">
                        {projectsToShow.map((project) => {
                            const isProjectMatched = matchedProjectIds?.has(project.id);
                            const isProcessing = project.processPercentage !== undefined;

                            return (
                                <SidebarMenuItem key={project.id}>
                                    <div className="group/project-row relative">
                                        <SidebarMenuButton
                                            className="min-w-0 pr-8"
                                            isActive={activeProjectName === project.name}
                                            onClick={() => {
                                                onSelectProject(group.id);
                                                router.push(`/${encodeURIComponent(group.name)}/${encodeURIComponent(project.name)}`);
                                            }}
                                            title={project.name}
                                            tooltip={project.name}
                                        >
                                            {isProcessing ? (
                                                <ProjectProgressChart project={project} />
                                            ) : (
                                                <BookOpen className="shrink-0" />
                                            )}
                                            <div className="w-0 min-w-0 flex-1 overflow-hidden">
                                                <span className="block truncate">
                                                    {highlightTerm && isProjectMatched
                                                        ? fuzzyHighlight(project.name, highlightTerm)
                                                        : project.name}
                                                </span>
                                            </div>
                                        </SidebarMenuButton>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                                                <SidebarMenuAction className="opacity-0 group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100 data-[state=open]:opacity-100">
                                                    <MoreVertical className="h-4 w-4" />
                                                    <span className="sr-only">{t("options")}</span>
                                                </SidebarMenuAction>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="start" side="right" className="w-40">
                                                <DropdownMenuItem onSelect={() => onEditProject(project, group.id)}>
                                                    <Edit className="mr-2 h-4 w-4" />
                                                    <span>{t("edit")}</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    className="text-destructive focus:text-destructive"
                                                    onSelect={() => {
                                                        onDeleteProject(project, group.id, group.name);
                                                    }}
                                                >
                                                    <Trash2 className="mr-2 h-4 w-4" />
                                                    <span>{t("delete")}</span>
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </SidebarMenuItem>
                            );
                        })}
                    </SidebarMenuSub>
                </CollapsibleContent>
            </Collapsible>
        </SidebarMenuItem>
    );
}
