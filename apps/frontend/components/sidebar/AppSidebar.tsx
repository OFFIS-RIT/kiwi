"use client";

import { Button } from "@/components/ui/button";
import { useCurrentSelection } from "@/hooks/use-current-selection";
import { useGroupsWithProjects } from "@/hooks/use-data";
import type { Group, Project } from "@/types";

import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
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
    SidebarMenuSubButton,
    SidebarMenuSubItem,
    SidebarRail,
} from "@/components/ui/sidebar";
import { usePrefetchProjectChat } from "@/hooks/use-prefetch-project-chat";
import { usePrefetchWhenVisible } from "@/hooks/use-prefetch-when-visible";
import { fetchProjectChats } from "@/lib/api";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { canCreateProjectInGroup, canDeleteTeam, canManageTeam, canOpenProjectEditorInGroup } from "@/lib/capabilities";
import { queryKeys } from "@/lib/query-keys";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useProjectChatSession } from "@/providers/ChatSessionsProvider";
import { useRuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { useSidebarExpansion } from "@/providers/SidebarExpansionProvider";
import { ProjectProgressChart } from "./ProjectProgressChart";
import Fuse from "fuse.js";
import {
    BookOpen,
    ChevronRight,
    Edit,
    FolderSearch,
    MoreVertical,
    Archive,
    Pin,
    Plus,
    Search,
    Trash2,
    Users,
    X,
} from "lucide-react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import type * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

const CreateProjectDialog = lazy(() =>
    import("@/components/projects").then((mod) => ({
        default: mod.CreateProjectDialog,
    }))
);

type SearchResult = {
    type: "group" | "project" | "chat";
    group: Group;
    project?: Project;
    chat?: Project["recentChats"][number];
    score: number;
};

const MIN_SEARCH_LENGTH = 1;
const RECENT_CHAT_LIMIT = 6;
const EMPTY_GROUPS: Group[] = [];
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function formatRelativeChatTime(updatedAt: string, now: number) {
    const timestamp = new Date(updatedAt).getTime();

    if (!Number.isFinite(timestamp)) {
        return "";
    }

    const elapsed = Math.max(0, now - timestamp);

    if (elapsed < HOUR_MS) {
        return `${Math.max(1, Math.floor(elapsed / MINUTE_MS))}m`;
    }

    if (elapsed < DAY_MS) {
        return `${Math.floor(elapsed / HOUR_MS)}h`;
    }

    if (elapsed < WEEK_MS) {
        return `${Math.floor(elapsed / DAY_MS)}d`;
    }

    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
    }).format(timestamp);
}

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
    onEditGroup: (group: Group) => void;
    onEditProject: (project: Project, groupId: string) => void;
    onDeleteGroup: (group: Group) => void;
    onDeleteProject: (project: Project, groupId: string, groupName: string) => void;
    onProjectCreated?: (projectId: string, groupId: string, projectName: string) => void;
};

export function AppSidebar({
    onEditGroup,
    onEditProject,
    onDeleteGroup,
    onDeleteProject,
    onProjectCreated,
    ...props
}: AppSidebarProps) {
    const t = useAppTranslations();
    const router = useRouter();
    const searchParams = useSearchParams();
    const chatId = searchParams.get("chatId");
    const { buildLabel } = useRuntimeConfig();
    const { data: groups = EMPTY_GROUPS, isLoading, error: queryError } = useGroupsWithProjects();
    const error = queryError ? t("error.loading.data") : null;
    const { isAdmin } = useAuth();
    const { group: selectedGroup, project: selectedProject } = useCurrentSelection();
    const homePrefetchRef = usePrefetchWhenVisible<HTMLButtonElement>("/");
    const {
        expandedGroups,
        expandedProjects,
        toggleGroupExpanded,
        toggleProjectExpanded,
        initializeExpandedGroups,
        initializeExpandedProjects,
        restoreExpansionAfterSearch,
        expandGroupsForSearch,
    } = useSidebarExpansion();

    const [showSearch, setShowSearch] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");
    const [createProjectGroupId, setCreateProjectGroupId] = useState<string | null>(null);
    const [ready, setReady] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const originalExpandedStateRef = useRef<Record<string, boolean>>({});
    const originalExpandedProjectsRef = useRef<Record<string, boolean>>({});
    const projectSelectedDuringSearchRef = useRef(false);
    const wasSearchingRef = useRef(false);
    const selectedGroupIdDuringSearchRef = useRef<string | null>(null);
    const expandedGroupsRef = useRef(expandedGroups);
    const expandedProjectsRef = useRef(expandedProjects);

    // Build flat list for Fuse.js search
    const searchableItems = useMemo(() => {
        const items: Array<{
            type: "group" | "project" | "chat";
            name: string;
            group: Group;
            project?: Project;
            chat?: Project["recentChats"][number];
        }> = [];

        groups.forEach((group) => {
            items.push({ type: "group", name: group.name, group });
            group.projects.forEach((project) => {
                items.push({ type: "project", name: project.name, group, project });
                project.recentChats.forEach((chat) => {
                    items.push({ type: "chat", name: chat.title, group, project, chat });
                });
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
            chat: r.item.chat,
            score: r.score ?? 1,
        }));
    }, [fuse, searchTerm]);

    const isSearching = searchTerm.trim().length >= MIN_SEARCH_LENGTH;

    const activeChatId = chatId;

    // Build grouped results for display
    const groupedResults = useMemo(() => {
        if (!isSearching) return null;

        const groupMap = new Map<
            string,
            {
                group: Group;
                matchedProjects: Set<string>;
                matchedChatsByProject: Map<string, Set<string>>;
                groupMatches: boolean;
            }
        >();

        searchResults.forEach((result) => {
            const groupId = result.group.id;
            if (!groupMap.has(groupId)) {
                groupMap.set(groupId, {
                    group: result.group,
                    matchedProjects: new Set(),
                    matchedChatsByProject: new Map(),
                    groupMatches: false,
                });
            }
            const entry = groupMap.get(groupId)!;
            if (result.type === "group") {
                entry.groupMatches = true;
            } else if (result.project) {
                entry.matchedProjects.add(result.project.id);
                if (result.type === "chat" && result.chat) {
                    const matchedChats = entry.matchedChatsByProject.get(result.project.id) ?? new Set<string>();
                    matchedChats.add(result.chat.id);
                    entry.matchedChatsByProject.set(result.project.id, matchedChats);
                }
            }
        });

        return groupMap;
    }, [searchResults, isSearching]);

    useEffect(() => {
        expandedGroupsRef.current = expandedGroups;
    }, [expandedGroups]);

    useEffect(() => {
        expandedProjectsRef.current = expandedProjects;
    }, [expandedProjects]);

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

    useEffect(() => {
        const projectIds = groups.flatMap((group) => group.projects.map((project) => project.id));
        if (projectIds.length === 0) return;
        initializeExpandedProjects(projectIds);
    }, [groups, initializeExpandedProjects]);

    useEffect(() => {
        if (!activeChatId) return;

        for (const group of groups) {
            const project = group.projects.find((candidate) =>
                candidate.recentChats.some((chat) => chat.id === activeChatId)
            );
            if (project) {
                expandGroupsForSearch([group.id], [project.id]);
                return;
            }
        }
    }, [activeChatId, groups, expandGroupsForSearch]);

    // Handle expansion state during search
    useEffect(() => {
        if (!isSearching) {
            if (wasSearchingRef.current) {
                if (projectSelectedDuringSearchRef.current && selectedGroupIdDuringSearchRef.current) {
                    const stateToRestore = { ...originalExpandedStateRef.current };
                    stateToRestore[selectedGroupIdDuringSearchRef.current] = true;
                    restoreExpansionAfterSearch(stateToRestore, originalExpandedProjectsRef.current);
                } else {
                    restoreExpansionAfterSearch(originalExpandedStateRef.current, originalExpandedProjectsRef.current);
                }
            }
            wasSearchingRef.current = false;
            return;
        }

        if (!wasSearchingRef.current) {
            originalExpandedStateRef.current = { ...expandedGroupsRef.current };
            originalExpandedProjectsRef.current = { ...expandedProjectsRef.current };
            projectSelectedDuringSearchRef.current = false;
            selectedGroupIdDuringSearchRef.current = null;
        }
        wasSearchingRef.current = true;

        if (groupedResults) {
            const groupIdsToExpand = Array.from(groupedResults.keys());
            const projectIdsToExpand = Array.from(groupedResults.values()).flatMap((entry) =>
                entry.groupMatches
                    ? []
                    : [...entry.matchedProjects, ...entry.matchedChatsByProject.keys()]
            );
            expandGroupsForSearch(groupIdsToExpand, projectIdsToExpand);
        }
    }, [isSearching, groupedResults, expandGroupsForSearch, restoreExpansionAfterSearch]);

    useEffect(() => {
        if (isSearching && selectedProject && selectedGroup) {
            projectSelectedDuringSearchRef.current = true;
            selectedGroupIdDuringSearchRef.current = selectedGroup.id;
        }
    }, [isSearching, selectedProject, selectedGroup]);

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

        return Array.from(groupedResults.values()).map(({ group, matchedProjects, matchedChatsByProject, groupMatches }) => ({
            ...group,
            projects: groupMatches
                ? group.projects
                : group.projects.filter((p) => matchedProjects.has(p.id) || matchedChatsByProject.has(p.id)),
            matchedProjectIds: matchedProjects,
            matchedChatsByProject,
            groupMatches,
        }));
    }, [groups, isSearching, groupedResults]);

    const organizationGroup = displayGroups.find((group) => group.scope === "organization");
    const teamGroups = displayGroups.filter((group) => group.scope === "team");

    return (
        <Sidebar {...props}>
            <SidebarHeader>
                <div className="flex items-center justify-between p-2">
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton ref={homePrefetchRef} size="lg" onClick={() => router.push("/")}>
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
                    <ScrollArea
                        className={`h-[calc(100vh-12rem)] transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-0"}`}
                    >
                        {organizationGroup ? (
                            <SidebarGroup>
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        {organizationGroup.projects.map((project) => (
                                            <ProjectItem
                                                key={project.id}
                                                project={project}
                                                group={organizationGroup}
                                                isExpanded={expandedProjects[project.id] ?? false}
                                                onToggleExpanded={() => toggleProjectExpanded(project.id)}
                                                activeChatId={activeChatId}
                                                isMatched={
                                                    isSearching && "matchedProjectIds" in organizationGroup
                                                        ? (organizationGroup.matchedProjectIds as Set<string>).has(
                                                              project.id
                                                          )
                                                        : false
                                                }
                                                matchedChatIds={
                                                    isSearching && "matchedChatsByProject" in organizationGroup
                                                        ? (
                                                              organizationGroup.matchedChatsByProject as Map<
                                                                  string,
                                                                  Set<string>
                                                              >
                                                          ).get(project.id)
                                                        : undefined
                                                }
                                                highlightTerm={isSearching ? searchTerm : undefined}
                                                onSelectProject={(groupId) => {
                                                    if (isSearching) {
                                                        projectSelectedDuringSearchRef.current = true;
                                                        selectedGroupIdDuringSearchRef.current = groupId;
                                                    }
                                                }}
                                                onEditProject={onEditProject}
                                                onDeleteProject={onDeleteProject}
                                            />
                                        ))}
                                    </SidebarMenu>
                                </SidebarGroupContent>
                            </SidebarGroup>
                        ) : null}
                        {teamGroups.map((group) => {
                            const context = { isAdmin };
                            const canEditTeam = canManageTeam(group, context);
                            const canCreateProject = canCreateProjectInGroup(group, context);
                            const canDeleteGroup = canDeleteTeam(group, context);
                            const showTeamMenu = canEditTeam || canCreateProject || canDeleteGroup;

                            return (
                                <SidebarGroup key={group.id}>
                                    <SidebarGroupLabel asChild className="px-2">
                                        <div className="group/team-row flex min-w-0 items-center gap-1 rounded-md transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
                                            <button
                                                type="button"
                                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                                                title={group.name}
                                                onClick={() => toggleGroupExpanded(group.id)}
                                            >
                                                <span className="block truncate">{group.name}</span>
                                                <ChevronRight
                                                    className={`h-4 w-4 shrink-0 text-sidebar-foreground/60 opacity-0 transition-[opacity,transform] group-hover/team-row:opacity-100 group-focus-within/team-row:opacity-100 ${expandedGroups[group.id] ? "rotate-90" : ""}`}
                                                />
                                            </button>
                                            {showTeamMenu ? (
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-5 w-5 shrink-0 p-0 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-hover/team-row:opacity-100 group-focus-within/team-row:opacity-100 data-[state=open]:opacity-100"
                                                            aria-label={t("options")}
                                                        >
                                                            <MoreVertical className="h-4 w-4" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="start" side="right" className="w-48">
                                                        {canEditTeam ? (
                                                            <DropdownMenuItem onSelect={() => onEditGroup(group)}>
                                                                <Edit className="mr-2 h-4 w-4" />
                                                                <span>{t("edit")}</span>
                                                            </DropdownMenuItem>
                                                        ) : null}
                                                        {canCreateProject ? (
                                                            <DropdownMenuItem
                                                                onSelect={() => setCreateProjectGroupId(group.id)}
                                                            >
                                                                <Plus className="mr-2 h-4 w-4" />
                                                                <span>{t("create.new.project")}</span>
                                                            </DropdownMenuItem>
                                                        ) : null}
                                                        {canDeleteGroup ? (
                                                            <DropdownMenuItem
                                                                className="text-destructive focus:text-destructive"
                                                                onSelect={() => onDeleteGroup(group)}
                                                            >
                                                                <Trash2 className="mr-2 h-4 w-4" />
                                                                <span>{t("delete")}</span>
                                                            </DropdownMenuItem>
                                                        ) : null}
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            ) : null}
                                        </div>
                                    </SidebarGroupLabel>
                                    <Suspense fallback={null}>
                                        <CreateProjectDialog
                                            open={createProjectGroupId === group.id}
                                            onOpenChange={(open) => setCreateProjectGroupId(open ? group.id : null)}
                                            groupId={group.id}
                                            onProjectCreated={onProjectCreated}
                                        />
                                    </Suspense>
                                    <SidebarGroupContent>
                                        {expandedGroups[group.id] ? (
                                            <SidebarMenu>
                                                {group.projects.map((project) => (
                                                    <ProjectItem
                                                        key={project.id}
                                                        project={project}
                                                        group={group}
                                                        isExpanded={expandedProjects[project.id] ?? false}
                                                        onToggleExpanded={() => toggleProjectExpanded(project.id)}
                                                        activeChatId={activeChatId}
                                                        isMatched={
                                                            isSearching && "matchedProjectIds" in group
                                                                ? (group.matchedProjectIds as Set<string>).has(
                                                                      project.id
                                                                  )
                                                                : false
                                                        }
                                                        matchedChatIds={
                                                            isSearching && "matchedChatsByProject" in group
                                                                ? (
                                                                      group.matchedChatsByProject as Map<
                                                                          string,
                                                                          Set<string>
                                                                      >
                                                                  ).get(project.id)
                                                                : undefined
                                                        }
                                                        highlightTerm={isSearching ? searchTerm : undefined}
                                                        onSelectProject={(groupId) => {
                                                            if (isSearching) {
                                                                projectSelectedDuringSearchRef.current = true;
                                                                selectedGroupIdDuringSearchRef.current = groupId;
                                                            }
                                                        }}
                                                        onEditProject={onEditProject}
                                                        onDeleteProject={onDeleteProject}
                                                    />
                                                ))}
                                            </SidebarMenu>
                                        ) : null}
                                    </SidebarGroupContent>
                                </SidebarGroup>
                            );
                        })}
                    </ScrollArea>
                ) : null}
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
            <SidebarRail />
        </Sidebar>
    );
}

type GroupItemProps = {
    group: Group;
    isExpanded: boolean;
    onToggleExpanded: () => void;
    highlightTerm?: string;
    matchedProjectIds?: Set<string>;
    matchedChatsByProject?: Map<string, Set<string>>;
    expandedProjects: Record<string, boolean>;
    onToggleProjectExpanded: (projectId: string) => void;
    activeChatId: string | null;
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
    onToggleExpanded,
    highlightTerm,
    matchedProjectIds,
    matchedChatsByProject,
    expandedProjects,
    onToggleProjectExpanded,
    activeChatId,
    onSelectProject,
    onEditProject,
    onEditGroup,
    onDeleteGroup,
    onDeleteProject,
    onProjectCreated,
}: GroupItemProps) {
    const t = useAppTranslations();
    const { isAdmin } = useAuth();
    const [showCreateProject, setShowCreateProject] = useState(false);

    const projectsToShow = group.projects;
    const context = { isAdmin };
    const canEditTeam = canManageTeam(group, context);
    const canCreateProject = canCreateProjectInGroup(group, context);
    const canDeleteGroup = canDeleteTeam(group, context);

    return (
        <SidebarMenuItem>
            <Collapsible className="group/collapsible" open={isExpanded} onOpenChange={onToggleExpanded}>
                <div className="group/group-row relative flex min-w-0 items-center gap-1">
                    <SidebarMenuButton
                        className="min-w-0 flex-1 pr-8"
                        onClick={onToggleExpanded}
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
                    {(canEditTeam || canCreateProject || canDeleteGroup) && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                                <SidebarMenuAction className="opacity-0 group-hover/group-row:opacity-100 group-focus-within/group-row:opacity-100 data-[state=open]:opacity-100">
                                    <MoreVertical className="h-4 w-4" />
                                    <span className="sr-only">{t("options")}</span>
                                </SidebarMenuAction>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" side="right" className="w-48">
                                {canEditTeam && (
                                    <DropdownMenuItem onSelect={() => onEditGroup(group)}>
                                        <Edit className="mr-2 h-4 w-4" />
                                        <span>{t("edit")}</span>
                                    </DropdownMenuItem>
                                )}
                                {canCreateProject && (
                                    <DropdownMenuItem onSelect={() => setShowCreateProject(true)}>
                                        <Plus className="mr-2 h-4 w-4" />
                                        <span>{t("create.new.project")}</span>
                                    </DropdownMenuItem>
                                )}
                                {canDeleteGroup && (
                                    <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onSelect={() => onDeleteGroup(group)}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        <span>{t("delete")}</span>
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
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
                        {projectsToShow.map((project) => (
                            <ProjectItem
                                key={project.id}
                                project={project}
                                group={group}
                                isExpanded={expandedProjects[project.id] ?? false}
                                onToggleExpanded={() => onToggleProjectExpanded(project.id)}
                                activeChatId={activeChatId}
                                isMatched={matchedProjectIds?.has(project.id) ?? false}
                                matchedChatIds={matchedChatsByProject?.get(project.id)}
                                highlightTerm={highlightTerm}
                                onSelectProject={onSelectProject}
                                onEditProject={onEditProject}
                                onDeleteProject={onDeleteProject}
                            />
                        ))}
                    </SidebarMenuSub>
                </CollapsibleContent>
            </Collapsible>
        </SidebarMenuItem>
    );
}

type ProjectItemProps = {
    project: Project;
    group: Group;
    isExpanded: boolean;
    onToggleExpanded: () => void;
    activeChatId: string | null;
    isMatched: boolean;
    matchedChatIds?: Set<string>;
    highlightTerm?: string;
    onSelectProject: (groupId: string) => void;
    onEditProject: (project: Project, groupId: string) => void;
    onDeleteProject: (project: Project, groupId: string, groupName: string) => void;
};

function ProjectItem({
    project,
    group,
    isExpanded,
    onToggleExpanded,
    activeChatId,
    isMatched,
    matchedChatIds,
    highlightTerm,
    onSelectProject,
    onEditProject,
    onDeleteProject,
}: ProjectItemProps) {
    const router = useRouter();
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const href = `/${group.id}/${project.id}`;
    const prefetchProjectChat = usePrefetchProjectChat(project.id);
    const prefetchRef = usePrefetchWhenVisible<HTMLButtonElement>(href, {
        onVisible: prefetchProjectChat,
    });
    const isProcessing = project.processPercentage !== undefined;
    const { isAdmin } = useAuth();
    const { requestNewEntry } = useProjectChatSession(project.id);
    const canOpenProjectEditor = canOpenProjectEditorInGroup(group, { isAdmin });
    const [showAllChats, setShowAllChats] = useState(false);
    const { data: allChats, isFetching: isFetchingAllChats } = useQuery({
        queryKey: queryKeys.projectChats(project.id),
        queryFn: () => fetchProjectChats(apiClient, project.id),
        enabled: showAllChats,
        staleTime: 30 * 1000,
    });
    const visibleChats = showAllChats ? (allChats ?? project.recentChats) : project.recentChats;
    const chatsToShow = matchedChatIds
        ? project.recentChats.filter((chat) => matchedChatIds.has(chat.id))
        : visibleChats;
    const canExpandChats = !matchedChatIds && project.recentChats.length >= RECENT_CHAT_LIMIT;
    const [now, setNow] = useState(() => Date.now());
    const hasChatTimes = chatsToShow.some((chat) => chat.updatedAt);

    useEffect(() => {
        if (!hasChatTimes) return;

        setNow(Date.now());

        const intervalId = window.setInterval(() => {
            setNow(Date.now());
        }, MINUTE_MS);

        return () => window.clearInterval(intervalId);
    }, [hasChatTimes]);

    const handleStartNewChat = () => {
        requestNewEntry({
            sessionId: uuidv4(),
            initialMessages: [],
        });
        router.push(href);
    };

    return (
        <SidebarMenuItem>
            <Collapsible className="group/project-collapsible" open={isExpanded} onOpenChange={onToggleExpanded}>
                <div className="group/project-row relative flex min-w-0 items-center gap-1">
                    <SidebarMenuButton
                        ref={prefetchRef}
                        className="min-w-0 flex-1 pr-8"
                        onClick={onToggleExpanded}
                        title={project.name}
                        tooltip={project.name}
                    >
                        {isProcessing ? <ProjectProgressChart project={project} /> : <BookOpen className="shrink-0" />}
                        <div className="w-0 min-w-0 flex-1 overflow-hidden">
                            <span className="block truncate">
                                {highlightTerm && isMatched
                                    ? fuzzyHighlight(project.name, highlightTerm)
                                    : project.name}
                            </span>
                        </div>
                    </SidebarMenuButton>
                    {canOpenProjectEditor && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                                <SidebarMenuAction className="right-7 opacity-0 group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100 data-[state=open]:opacity-100">
                                    <MoreVertical className="h-4 w-4" />
                                    <span className="sr-only">{t("options")}</span>
                                </SidebarMenuAction>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" side="right" className="w-40">
                                <DropdownMenuItem onSelect={() => onEditProject(project, group.id)}>
                                    <Edit className="mr-2 h-4 w-4" />
                                    <span>{t("edit")}</span>
                                </DropdownMenuItem>
                                {canCreateProjectInGroup(group, { isAdmin }) && (
                                    <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onSelect={() => {
                                            onDeleteProject(project, group.id, group.name);
                                        }}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        <span>{t("delete")}</span>
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-1.5 h-5 w-5 p-0 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100"
                        onClick={(event) => {
                            event.stopPropagation();
                            handleStartNewChat();
                        }}
                        aria-label={t("new.chat")}
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>
                <CollapsibleContent>
                    <SidebarMenuSub className="mr-0 pr-0">
                        {chatsToShow.length > 0 ? (
                            chatsToShow.map((chat) => {
                                const relativeUpdatedAt = chat.updatedAt
                                    ? formatRelativeChatTime(chat.updatedAt, now)
                                    : null;

                                return (
                                    <SidebarMenuSubItem key={chat.id} className="group/chat-row">
                                        <SidebarMenuSubButton
                                            asChild
                                            size="sm"
                                            isActive={activeChatId === chat.id}
                                            className="relative w-full justify-start"
                                            onMouseEnter={prefetchProjectChat}
                                            onFocus={prefetchProjectChat}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    onSelectProject(group.id);
                                                    router.push(`${href}?chatId=${encodeURIComponent(chat.id)}`);
                                                }}
                                                title={chat.title}
                                            >
                                                <span className="min-w-0 flex-1 truncate pr-9 text-left">{chat.title}</span>
                                                {relativeUpdatedAt ? (
                                                    <span className="absolute right-2 shrink-0 text-muted-foreground group-hover/chat-row:hidden">
                                                        {relativeUpdatedAt}
                                                    </span>
                                                ) : null}
                                            </button>
                                        </SidebarMenuSubButton>
                                        <div
                                            className="pointer-events-none absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-1 text-muted-foreground group-hover/chat-row:flex"
                                            aria-hidden="true"
                                        >
                                            <span className="flex h-5 w-5 items-center justify-center">
                                                <Pin className="h-3.5 w-3.5" />
                                            </span>
                                            <span className="flex h-5 w-5 items-center justify-center">
                                                <Archive className="h-3.5 w-3.5" />
                                            </span>
                                        </div>
                                    </SidebarMenuSubItem>
                                );
                            })
                        ) : (
                            <SidebarMenuSubItem>
                                <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("no.chats")}</div>
                            </SidebarMenuSubItem>
                        )}
                        {canExpandChats ? (
                            <SidebarMenuSubItem>
                                <SidebarMenuSubButton
                                    asChild
                                    size="sm"
                                    className="w-full justify-start text-muted-foreground"
                                    aria-disabled={isFetchingAllChats}
                                >
                                    <button
                                        type="button"
                                        disabled={isFetchingAllChats}
                                        onClick={() => setShowAllChats((value) => !value)}
                                    >
                                        <span>
                                            {isFetchingAllChats
                                                ? t("loading")
                                                : showAllChats
                                                  ? t("show.less")
                                                  : t("show.more")}
                                        </span>
                                    </button>
                                </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                        ) : null}
                    </SidebarMenuSub>
                </CollapsibleContent>
            </Collapsible>
        </SidebarMenuItem>
    );
}
