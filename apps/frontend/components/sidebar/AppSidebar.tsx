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
import { deleteProjectChat, fetchProjectChats } from "@/lib/api";
import type { ChatSummaryItem } from "@/lib/api";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { canCreateProjectInGroup, canDeleteTeam, canManageTeam, canOpenProjectEditorInGroup } from "@/lib/capabilities";
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
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";

const CreateProjectDialog = lazy(() =>
    import("@/components/projects").then((mod) => ({
        default: mod.CreateProjectDialog,
    }))
);

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

type SearchTarget = {
    id: string;
    type: "group" | "project" | "chat";
    label: string;
    group: Group;
    project?: Project;
    chat?: ChatSummaryItem;
};

type ProjectSearchScope = {
    group: Group;
    project: Project;
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
    const [createProjectGroupId, setCreateProjectGroupId] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    const projectSearchScopes = useMemo(
        () =>
            groups.flatMap((group) =>
                group.projects.map((project): ProjectSearchScope => ({
                    group,
                    project,
                }))
            ),
        [groups]
    );

    const projectChatQueries = useQueries({
        queries: projectSearchScopes.map(({ project }) => ({
            queryKey: queryKeys.projectChats(project.id),
            queryFn: () => fetchProjectChats(apiClient, project.id),
            enabled: searchOpen,
            staleTime: 5 * MINUTE_MS,
        })),
    });

    const searchTargets = useMemo(() => {
        const groupsTargets: SearchTarget[] = [];
        const projectTargets: SearchTarget[] = [];
        const chatTargets: SearchTarget[] = [];

        for (const group of groups) {
            groupsTargets.push({
                id: `group:${group.id}`,
                type: "group",
                label: group.name,
                group,
            });
        }

        projectSearchScopes.forEach(({ group, project }, index) => {
            projectTargets.push({
                id: `project:${project.id}`,
                type: "project",
                label: project.name,
                group,
                project,
            });

            const chats = projectChatQueries[index]?.data ?? project.recentChats;
            chats.forEach((chat) => {
                chatTargets.push({
                    id: `chat:${chat.id}`,
                    type: "chat",
                    label: chat.title,
                    group,
                    project,
                    chat,
                });
            });
        });

        return { groups: groupsTargets, projects: projectTargets, chats: chatTargets };
    }, [groups, projectChatQueries, projectSearchScopes]);

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

    const openSearchTarget = (target: SearchTarget) => {
        const projectIds = target.project ? [target.project.id] : [];
        expandSidebarPath([target.group.id], projectIds);
        setSearchOpen(false);

        if (target.type === "chat" && target.project && target.chat) {
            router.push(`/${target.group.id}/${target.project.id}?chatId=${encodeURIComponent(target.chat.id)}`);
            return;
        }

        if (target.type === "project" && target.project) {
            router.push(`/${target.group.id}/${target.project.id}`);
            return;
        }

        router.push(`/${target.group.id}`);
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
                >
                    <CommandInput placeholder={t("search.placeholder")} />
                    <CommandList>
                        <CommandEmpty>{t("no.search.results")}</CommandEmpty>
                        <CommandGroup heading={t("knowledge.groups")}>
                            {searchTargets.groups.map((target) => (
                                <CommandItem
                                    key={target.id}
                                    value={`${target.label} ${target.group.name}`}
                                    onSelect={() => openSearchTarget(target)}
                                >
                                    <Users />
                                    <span>{target.label}</span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                        <CommandGroup heading={t("knowledge.projects")}>
                            {searchTargets.projects.map((target) => (
                                <CommandItem
                                    key={target.id}
                                    value={`${target.label} ${target.group.name}`}
                                    onSelect={() => openSearchTarget(target)}
                                >
                                    <BookOpen />
                                    <div className="flex min-w-0 flex-col">
                                        <span className="truncate">{target.label}</span>
                                        <span className="truncate text-xs text-muted-foreground">{target.group.name}</span>
                                    </div>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                        <CommandGroup heading={t("chats")}>
                            {searchTargets.chats.map((target) => (
                                <CommandItem
                                    key={target.id}
                                    value={`${target.label} ${target.project?.name ?? ""} ${target.group.name}`}
                                    onSelect={() => openSearchTarget(target)}
                                >
                                    <Mail />
                                    <div className="flex min-w-0 flex-col">
                                        <span className="truncate">{target.label}</span>
                                        <span className="truncate text-xs text-muted-foreground">
                                            {target.project?.name}
                                        </span>
                                    </div>
                                </CommandItem>
                            ))}
                        </CommandGroup>
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
    const [manuallyUnreadChatIds, setManuallyUnreadChatIds] = useState<Set<string>>(() => new Set());
    const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);
    const [chatToDelete, setChatToDelete] = useState<Project["recentChats"][number] | null>(null);
    const { data: allChats, isFetching: isFetchingAllChats } = useQuery({
        queryKey: queryKeys.projectChats(project.id),
        queryFn: () => fetchProjectChats(apiClient, project.id),
        enabled: showAllChats,
        staleTime: 30 * 1000,
    });
    const deleteChatMutation = useMutation({
        mutationFn: (conversationId: string) => deleteProjectChat(apiClient, project.id, conversationId),
        onSuccess: (_data, conversationId) => {
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
            queryClient.invalidateQueries({ queryKey: queryKeys.projectChats(project.id) });
            setManuallyUnreadChatIds((current) => {
                const next = new Set(current);
                next.delete(conversationId);
                return next;
            });

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
    const visibleChats = showAllChats && allChats && !isFetchingAllChats ? allChats : project.recentChats;
    const chatsToShow = visibleChats;
    const canExpandChats = project.recentChats.length > RECENT_CHAT_LIMIT;
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

    useEffect(() => {
        if (!chatToDelete) {
            deleteChatMutation.reset();
        }
    }, [chatToDelete, deleteChatMutation]);

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

    const handleToggleAllChats = () => {
        if (!showAllChats) {
            queryClient.removeQueries({ queryKey: queryKeys.projectChats(project.id), exact: true });
        }
        setShowAllChats((value) => !value);
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
                                                    {chat.title}
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
                                                <DropdownMenuItem>
                                                    <Pin className="mr-2 h-4 w-4" />
                                                    <span>{t("chat.pin")}</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem>
                                                    <Edit className="mr-2 h-4 w-4" />
                                                    <span>{t("chat.rename")}</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem>
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
                                    aria-disabled={isFetchingAllChats}
                                >
                                    <button
                                        type="button"
                                        disabled={isFetchingAllChats}
                                        onClick={handleToggleAllChats}
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
