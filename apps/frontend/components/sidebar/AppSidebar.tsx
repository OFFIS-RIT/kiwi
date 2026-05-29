"use client";

import { Button } from "@/components/ui/button";
import { useGroupsWithProjects } from "@/hooks/use-data";
import type { Group, Project } from "@/types";

import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
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
import {
    archiveProjectChat,
    deleteProjectChat,
    fetchProjectChatsPage,
    pinProjectChat,
    searchSidebarTargets,
    unpinProjectChat,
    type SearchChatItem,
    type SearchProjectItem,
    type SearchTeamItem,
} from "@/lib/api";
import { mergeUniqueProjectChats, sortProjectChats } from "@/lib/chat-summaries";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { canCreateProjectInGroup, canDeleteTeam, canManageTeam, canOpenProjectEditorInGroup } from "@/lib/capabilities";
import { ORGANIZATION_GROUP_ID, PERSONAL_GROUP_ID } from "@/lib/api/projects";
import { queryKeys } from "@/lib/query-keys";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useProjectChatSession } from "@/providers/ChatSessionsProvider";
import { useRuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { useSidebarExpansion } from "@/providers/SidebarExpansionProvider";
import { ProjectProgressChart } from "./ProjectProgressChart";
import {
    BookOpen,
    ChevronRight,
    Edit,
    Loader2,
    Mail,
    MoreVertical,
    Archive,
    Pin,
    Plus,
    Search,
    Trash2,
    Users,
} from "lucide-react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useDeferredValue, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";

const CreateProjectDialog = lazy(() =>
    import("@/components/projects").then((mod) => ({
        default: mod.CreateProjectDialog,
    }))
);

const RECENT_CHAT_LIMIT = 5;
const PRELOADED_CHAT_LIMIT = RECENT_CHAT_LIMIT + 1;
const CHAT_PAGE_SIZE = 12;
const EMPTY_GROUPS: Group[] = [];
const EMPTY_SEARCH_RESULTS = {
    projects: [] as SearchProjectItem[],
    teams: [] as SearchTeamItem[],
    chats: [] as SearchChatItem[],
};
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

type SearchTarget =
    | ({ type: "team" } & SearchTeamItem)
    | ({ type: "project" } & SearchProjectItem)
    | ({ type: "chat" } & SearchChatItem);

function getProjectGroupRouteId(scope: SearchProjectItem["scope"], teamId: string | null) {
    if (scope === "organization") {
        return ORGANIZATION_GROUP_ID;
    }

    if (scope === "private") {
        return PERSONAL_GROUP_ID;
    }

    return teamId ?? ORGANIZATION_GROUP_ID;
}

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
    const apiClient = useApiClient();
    const { data: groups = EMPTY_GROUPS, isLoading, error: queryError } = useGroupsWithProjects();
    const error = queryError ? t("error.loading.data") : null;
    const { isAdmin } = useAuth();
    const homePrefetchRef = usePrefetchWhenVisible<HTMLButtonElement>("/");
    const {
        expandedGroups,
        expandedProjects,
        toggleGroupExpanded,
        toggleProjectExpanded,
        initializeExpandedGroups,
        initializeExpandedProjects,
        expandSidebarPath,
    } = useSidebarExpansion();

    const [searchOpen, setSearchOpen] = useState(false);
    const [searchValue, setSearchValue] = useState("");
    const [createProjectGroupId, setCreateProjectGroupId] = useState<string | null>(null);
    const [ready, setReady] = useState(false);
    const deferredSearchValue = useDeferredValue(searchValue.trim());
    const { data: searchResults = EMPTY_SEARCH_RESULTS, isFetching: isSearching } = useQuery({
        queryKey: queryKeys.search(deferredSearchValue),
        queryFn: () => searchSidebarTargets(apiClient, deferredSearchValue),
        enabled: searchOpen && deferredSearchValue.length >= 2,
        staleTime: 30 * 1000,
    });

    const activeChatId = chatId;

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
                expandSidebarPath([group.id], [project.id]);
                return;
            }
        }
    }, [activeChatId, groups, expandSidebarPath]);

    useEffect(() => {
        if (searchOpen) {
            return;
        }

        setSearchValue("");
    }, [searchOpen]);

    const openSearchTarget = (target: SearchTarget) => {
        setSearchOpen(false);

        if (target.type === "team") {
            expandSidebarPath([target.id]);
            router.push(`/${target.id}`);
            return;
        }

        const groupId = getProjectGroupRouteId(target.scope, target.teamId);
        const projectId = target.type === "project" ? target.id : target.projectId;
        expandSidebarPath([groupId], [projectId]);

        if (target.type === "project") {
            router.push(`/${groupId}/${projectId}`);
            return;
        }

        router.push(`/${groupId}/${target.projectId}?chatId=${encodeURIComponent(target.id)}`);
    };

    const organizationGroup = groups.find((group) => group.scope === "organization");
    const teamGroups = groups.filter((group) => group.scope === "team");

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
                        className="h-8 w-8 text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        onClick={() => setSearchOpen(true)}
                    >
                        <Search className="h-4 w-4" />
                        <span className="sr-only">{t("search")}</span>
                    </Button>
                </div>
                <CommandDialog
                    open={searchOpen}
                    onOpenChange={setSearchOpen}
                    title={t("search")}
                    description={t("search.placeholder")}
                    commandProps={{ shouldFilter: false }}
                >
                    <CommandInput
                        placeholder={t("search.placeholder")}
                        value={searchValue}
                        onValueChange={setSearchValue}
                    />
                    <CommandList>
                        <CommandEmpty>
                            {deferredSearchValue.length < 2
                                ? t("search.min.chars", { count: 2 })
                                : isSearching
                                  ? t("loading")
                                  : t("search.try.different")}
                        </CommandEmpty>
                        {searchResults.projects.length > 0 ? (
                            <CommandGroup heading={t("knowledge.projects")}>
                                {searchResults.projects.map((target) => (
                                    <CommandItem
                                        key={target.id}
                                        value={`${target.name} ${target.teamName ?? ""}`}
                                        onSelect={() => openSearchTarget({ ...target, type: "project" })}
                                    >
                                        <BookOpen />
                                        <div className="flex min-w-0 flex-col">
                                            <span className="truncate">{target.name}</span>
                                            <span className="truncate text-xs text-muted-foreground">
                                                {target.teamName ??
                                                    (target.scope === "organization"
                                                        ? t("organization")
                                                        : target.scope === "private"
                                                          ? t("personal")
                                                          : "")}
                                            </span>
                                        </div>
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        ) : null}
                        {searchResults.teams.length > 0 ? (
                            <CommandGroup heading={t("knowledge.groups")}>
                                {searchResults.teams.map((target) => (
                                    <CommandItem
                                        key={target.id}
                                        value={target.name}
                                        onSelect={() => openSearchTarget({ ...target, type: "team" })}
                                    >
                                        <Users />
                                        <span>{target.name}</span>
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        ) : null}
                        {searchResults.chats.length > 0 ? (
                            <CommandGroup heading={t("chats")}>
                                {searchResults.chats.map((target) => (
                                    <CommandItem
                                        key={target.id}
                                        value={`${target.title} ${target.projectName} ${target.teamName ?? ""}`}
                                        onSelect={() => openSearchTarget({ ...target, type: "chat" })}
                                    >
                                        <Mail />
                                        <div className="flex min-w-0 flex-col">
                                            <span className="truncate">{target.title}</span>
                                            <span className="truncate text-xs text-muted-foreground">
                                                {target.projectName}
                                            </span>
                                        </div>
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        ) : null}
                    </CommandList>
                </CommandDialog>
            </SidebarHeader>
            <SidebarContent>
                {error ? (
                    <div className="px-2 py-4 text-center text-sm text-destructive">{error}</div>
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

type ProjectItemProps = {
    project: Project;
    group: Group;
    isExpanded: boolean;
    onToggleExpanded: () => void;
    activeChatId: string | null;
    onEditProject: (project: Project, groupId: string) => void;
    onDeleteProject: (project: Project, groupId: string, groupName: string) => void;
};

function ProjectItem({
    project,
    group,
    isExpanded,
    onToggleExpanded,
    activeChatId,
    onEditProject,
    onDeleteProject,
}: ProjectItemProps) {
    const router = useRouter();
    const pathname = usePathname();
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const queryClient = useQueryClient();
    const href = `/${group.id}/${project.id}`;
    const prefetchProjectChat = usePrefetchProjectChat(project.id);
    const prefetchRef = usePrefetchWhenVisible<HTMLButtonElement>(href, {
        onVisible: prefetchProjectChat,
    });
    const isProcessing = project.processPercentage !== undefined;
    const { isAdmin } = useAuth();
    const { entries, requestNewEntry, resetEntry, setHasUnreadUpdate } = useProjectChatSession(project.id);
    const canOpenProjectEditor = canOpenProjectEditorInGroup(group, { isAdmin });
    const [showAllChats, setShowAllChats] = useState(false);
    const [loadedChats, setLoadedChats] = useState<Project["recentChats"] | null>(null);
    const [hasMoreChats, setHasMoreChats] = useState(project.recentChats.length > RECENT_CHAT_LIMIT);
    const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);
    const [manuallyUnreadChatIds, setManuallyUnreadChatIds] = useState<Set<string>>(() => new Set());
    const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);
    const [chatToDelete, setChatToDelete] = useState<Project["recentChats"][number] | null>(null);
    const updateCachedChats = (
        updater: (chats: Project["recentChats"]) => Project["recentChats"],
        options: { mayHaveMore?: boolean } = {}
    ) => {
        setLoadedChats((current) => (current ? sortProjectChats(updater(current)) : current));
        queryClient.setQueryData<Project["recentChats"]>(queryKeys.projectChats(project.id), (current) =>
            current ? sortProjectChats(updater(current)) : current
        );
        queryClient.setQueryData<Group[]>(queryKeys.groupsWithProjects, (groups) =>
            groups?.map((candidateGroup) => ({
                ...candidateGroup,
                projects: candidateGroup.projects.map((candidateProject) =>
                    candidateProject.id === project.id
                        ? {
                              ...candidateProject,
                              recentChats: sortProjectChats(updater(candidateProject.recentChats)).slice(
                                  0,
                                  PRELOADED_CHAT_LIMIT
                              ),
                          }
                        : candidateProject
                ),
            }))
        );

        if (options.mayHaveMore) {
            setHasMoreChats(true);
        }
    };

    const removeChatFromCaches = (conversationId: string) => {
        updateCachedChats((chats) => chats.filter((chat) => chat.id !== conversationId), {
            mayHaveMore: !hasMoreChats,
        });
        setManuallyUnreadChatIds((current) => {
            const next = new Set(current);
            next.delete(conversationId);
            return next;
        });
    };

    const togglePinChatMutation = useMutation({
        mutationFn: ({ conversationId, isPinned }: { conversationId: string; isPinned: boolean }) =>
            isPinned
                ? unpinProjectChat(apiClient, project.id, conversationId)
                : pinProjectChat(apiClient, project.id, conversationId),
        onSuccess: (_data, { conversationId, isPinned }) => {
            updateCachedChats((chats) =>
                chats.map((chat) => (chat.id === conversationId ? { ...chat, isPinned: !isPinned } : chat))
            );
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
            queryClient.invalidateQueries({ queryKey: queryKeys.projectChats(project.id) });
        },
        onError: () => {
            toast.error(t("error.unexpected.try.again"));
        },
    });
    const archiveChatMutation = useMutation({
        mutationFn: (conversationId: string) => archiveProjectChat(apiClient, project.id, conversationId),
        onSuccess: (_data, conversationId) => {
            removeChatFromCaches(conversationId);
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
            queryClient.invalidateQueries({ queryKey: queryKeys.projectChats(project.id) });

            if (activeChatId === conversationId) {
                resetEntry();
                if (pathname === href) {
                    window.history.pushState(null, "", href);
                    return;
                }
                router.push(href);
            }
        },
        onError: () => {
            toast.error(t("error.unexpected.try.again"));
        },
    });
    const deleteChatMutation = useMutation({
        mutationFn: (conversationId: string) => deleteProjectChat(apiClient, project.id, conversationId),
        onSuccess: (_data, conversationId) => {
            removeChatFromCaches(conversationId);
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
            queryClient.invalidateQueries({ queryKey: queryKeys.projectChats(project.id) });

            if (activeChatId === conversationId) {
                resetEntry();
                if (pathname === href) {
                    window.history.pushState(null, "", href);
                    return;
                }
                router.push(href);
            }
        },
    });
    const deleteChatError = deleteChatMutation.error
        ? deleteChatMutation.error instanceof Error
            ? deleteChatMutation.error.message
            : t("delete.chat.error")
        : null;
    const isMutatingChat =
        togglePinChatMutation.isPending || archiveChatMutation.isPending || deleteChatMutation.isPending;
    const chatsToShow = showAllChats ? loadedChats ?? project.recentChats : project.recentChats.slice(0, RECENT_CHAT_LIMIT);
    const canExpandChats =
        hasMoreChats || project.recentChats.length > RECENT_CHAT_LIMIT || (loadedChats?.length ?? 0) > RECENT_CHAT_LIMIT;
    const runningChatIds = useMemo(
        () => new Set(entries.filter((entry) => entry.isGenerating).map((entry) => entry.sessionId)),
        [entries]
    );
    const unreadChatIds = useMemo(
        () => new Set(entries.filter((entry) => entry.hasUnreadUpdate).map((entry) => entry.sessionId)),
        [entries]
    );
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

    const resetDeleteMutation = deleteChatMutation.reset;
    useEffect(() => {
        if (!chatToDelete) {
            resetDeleteMutation();
        }
    }, [chatToDelete, resetDeleteMutation]);

    useEffect(() => {
        setLoadedChats((current) =>
            current ? sortProjectChats(mergeUniqueProjectChats(project.recentChats, current)) : current
        );
    }, [project.recentChats]);

    useEffect(() => {
        if (!loadedChats) {
            setHasMoreChats(project.recentChats.length > RECENT_CHAT_LIMIT);
        }
    }, [loadedChats, project.recentChats.length]);

    const handleStartNewChat = () => {
        requestNewEntry({
            sessionId: uuidv4(),
            initialMessages: [],
        });
        if (pathname === href) {
            window.history.pushState(null, "", href);
            return;
        }
        router.push(href);
    };

    const handleToggleAllChats = async () => {
        if (showAllChats && !hasMoreChats) {
            setShowAllChats(false);
            return;
        }

        if (!showAllChats && loadedChats && (loadedChats.length > project.recentChats.length || !hasMoreChats)) {
            setShowAllChats(true);
            return;
        }

        const currentChats = loadedChats ?? project.recentChats;
        const preloadedExtraCount = loadedChats ? 0 : Math.max(0, project.recentChats.length - RECENT_CHAT_LIMIT);
        const limit = loadedChats ? CHAT_PAGE_SIZE : CHAT_PAGE_SIZE - preloadedExtraCount;
        const wasCollapsed = !showAllChats;
        setShowAllChats(true);

        if (limit <= 0 || isLoadingMoreChats) {
            return;
        }

        setIsLoadingMoreChats(true);

        try {
            const nextPage = await fetchProjectChatsPage(apiClient, project.id, {
                offset: currentChats.length,
                limit,
            });
            const nextChats = sortProjectChats(mergeUniqueProjectChats(currentChats, nextPage.items));
            setLoadedChats(nextChats);
            queryClient.setQueryData(queryKeys.projectChats(project.id), nextChats);
            setHasMoreChats(nextPage.hasMore);
        } catch (error) {
            if (wasCollapsed) {
                setShowAllChats(false);
            }
            console.error("Failed to load more chats:", error);
            toast.error(t("error.unexpected.try.again"));
        } finally {
            setIsLoadingMoreChats(false);
        }
    };

    const markChatAsUnread = (conversationId: string) => {
        setHasUnreadUpdate(conversationId, true);
        setManuallyUnreadChatIds((current) => new Set(current).add(conversationId));
    };

    const markChatAsRead = (conversationId: string) => {
        setManuallyUnreadChatIds((current) => {
            if (!current.has(conversationId)) return current;
            const next = new Set(current);
            next.delete(conversationId);
            return next;
        });
    };

    const handleDeleteChat = async () => {
        if (!chatToDelete) return;

        try {
            await deleteChatMutation.mutateAsync(chatToDelete.id);
            setChatToDelete(null);
        } catch (error) {
            console.error("Failed to delete chat:", error);
        }
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
                            <span className="block truncate">{project.name}</span>
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
                                const isGenerating = runningChatIds.has(chat.id);
                                const hasBackgroundUpdate =
                                    activeChatId !== chat.id &&
                                    (unreadChatIds.has(chat.id) || manuallyUnreadChatIds.has(chat.id));
                                const relativeUpdatedAt = chat.updatedAt
                                    ? formatRelativeChatTime(chat.updatedAt, now)
                                    : null;
                                const isChatMenuOpen = openChatMenuId === chat.id;

                                return (
                                    <SidebarMenuSubItem key={chat.id} className="group/chat-row">
                                        <SidebarMenuSubButton
                                            asChild
                                            size="sm"
                                            isActive={activeChatId === chat.id}
                                            className="relative w-full justify-start pr-8"
                                            onMouseEnter={() => prefetchProjectChat(chat.id)}
                                            onFocus={() => prefetchProjectChat(chat.id)}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    markChatAsRead(chat.id);
                                                    const chatHref = `${href}?chatId=${encodeURIComponent(chat.id)}`;
                                                    if (pathname === href) {
                                                        window.history.pushState(null, "", chatHref);
                                                        return;
                                                    }
                                                    router.push(chatHref);
                                                }}
                                                title={chat.title}
                                            >
                                                <span className="block w-0 min-w-0 flex-1 truncate pr-9 text-left">
                                                    <span className="flex min-w-0 items-center gap-1.5">
                                                        {chat.isPinned ? (
                                                            <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
                                                        ) : null}
                                                        <span className="truncate">{chat.title}</span>
                                                    </span>
                                                </span>
                                                {!isChatMenuOpen && isGenerating ? (
                                                    <span className="absolute right-2 shrink-0 text-muted-foreground group-hover/chat-row:hidden">
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    </span>
                                                ) : !isChatMenuOpen && hasBackgroundUpdate ? (
                                                    <span className="absolute right-2 h-2 w-2 shrink-0 rounded-full bg-sky-400 group-hover/chat-row:hidden" />
                                                ) : !isChatMenuOpen && relativeUpdatedAt ? (
                                                    <span className="absolute right-2 shrink-0 text-muted-foreground group-hover/chat-row:hidden">
                                                        {relativeUpdatedAt}
                                                    </span>
                                                ) : null}
                                            </button>
                                        </SidebarMenuSubButton>
                                        <DropdownMenu
                                            open={isChatMenuOpen}
                                            onOpenChange={(open) => setOpenChatMenuId(open ? chat.id : null)}
                                        >
                                            <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className={`absolute right-1 top-1/2 h-5 w-5 -translate-y-1/2 p-0 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-hover/chat-row:opacity-100 ${isChatMenuOpen ? "opacity-100" : ""}`}
                                                    aria-label={t("chat.options")}
                                                >
                                                    <MoreVertical className="h-4 w-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="start" side="right" className="w-44">
                                                <DropdownMenuItem
                                                    disabled={isMutatingChat}
                                                    onSelect={() =>
                                                        togglePinChatMutation.mutate({
                                                            conversationId: chat.id,
                                                            isPinned: chat.isPinned,
                                                        })
                                                    }
                                                >
                                                    <Pin className="mr-2 h-4 w-4" />
                                                    <span>{chat.isPinned ? t("chat.unpin") : t("chat.pin")}</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem>
                                                    <Edit className="mr-2 h-4 w-4" />
                                                    <span>{t("chat.rename")}</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    disabled={isMutatingChat}
                                                    onSelect={() => archiveChatMutation.mutate(chat.id)}
                                                >
                                                    <Archive className="mr-2 h-4 w-4" />
                                                    <span>{t("chat.archive")}</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onSelect={() => markChatAsUnread(chat.id)}>
                                                    <Mail className="mr-2 h-4 w-4" />
                                                    <span>{t("chat.mark.unread")}</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    variant="destructive"
                                                    disabled={deleteChatMutation.isPending}
                                                    onSelect={() => setChatToDelete(chat)}
                                                >
                                                    <Trash2 className="mr-2 h-4 w-4" />
                                                    <span>{t("chat.delete")}</span>
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
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
                                    aria-disabled={isLoadingMoreChats || isMutatingChat}
                                >
                                    <button
                                        type="button"
                                        disabled={isLoadingMoreChats || isMutatingChat}
                                        onClick={() => void handleToggleAllChats()}
                                    >
                                        <span>
                                            {isLoadingMoreChats
                                                ? t("loading")
                                                : showAllChats && !hasMoreChats
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
            <Dialog open={chatToDelete !== null} onOpenChange={(open) => !open && setChatToDelete(null)}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>{t("delete.chat.confirm")}</DialogTitle>
                        <DialogDescription>
                            {t("delete.chat.description", {
                                chatTitle: chatToDelete?.title || "",
                            })}
                        </DialogDescription>
                    </DialogHeader>

                    {deleteChatError && (
                        <div className="bg-destructive/15 text-destructive rounded-md px-4 py-2 text-sm">
                            {deleteChatError}
                        </div>
                    )}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setChatToDelete(null)}
                            disabled={deleteChatMutation.isPending}
                        >
                            {t("cancel")}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleDeleteChat}
                            disabled={deleteChatMutation.isPending}
                        >
                            {deleteChatMutation.isPending ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : null}
                            {t("delete")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </SidebarMenuItem>
    );
}
