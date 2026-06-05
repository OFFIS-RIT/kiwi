"use client";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { fetchArchivedChats, unarchiveProjectChat, unarchiveTeamChat, type ChatLibraryItem } from "@/lib/api";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { queryKeys } from "@/lib/query-keys";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Loader2, MessageSquare } from "lucide-react";
import { toast } from "sonner";

const ARCHIVED_PAGE_SIZE = 20;

export function ArchivedChatList() {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const queryClient = useQueryClient();
    const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
        queryKey: queryKeys.archivedChats,
        queryFn: ({ pageParam }) => fetchArchivedChats(apiClient, { offset: pageParam, limit: ARCHIVED_PAGE_SIZE }),
        initialPageParam: 0,
        getNextPageParam: (lastPage, allPages) =>
            lastPage.hasMore ? allPages.reduce((total, page) => total + page.items.length, 0) : undefined,
    });

    const chats = data?.pages.flatMap((page) => page.items) ?? [];

    const unarchiveMutation = useMutation({
        mutationFn: (chat: ChatLibraryItem) =>
            chat.targetType === "graph"
                ? unarchiveProjectChat(apiClient, chat.projectId, chat.id)
                : unarchiveTeamChat(apiClient, chat.teamId, chat.id),
        onSuccess: (_data, chat) => {
            queryClient.invalidateQueries({ queryKey: queryKeys.archivedChats });
            queryClient.invalidateQueries({ queryKey: queryKeys.pinnedChats });
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
            if (chat.targetType === "graph") {
                queryClient.invalidateQueries({ queryKey: queryKeys.projectChats(chat.projectId) });
            } else {
                queryClient.invalidateQueries({ queryKey: queryKeys.teamChats(chat.teamId) });
            }
        },
        onError: () => {
            toast.error(t("error.unexpected.try.again"));
        },
    });

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (chats.length === 0) {
        return <p className="py-12 text-center text-sm text-muted-foreground">{t("settings.archived.empty")}</p>;
    }

    return (
        <div className="space-y-1">
            {chats.map((chat, index) => {
                const isUnarchiving = unarchiveMutation.isPending && unarchiveMutation.variables?.id === chat.id;

                return (
                    <div key={chat.id}>
                        <div className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                                <MessageSquare className="h-4 w-4 text-primary" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">{chat.title}</span>
                                <span className="block truncate text-xs text-muted-foreground">
                                    {chat.projectName ?? chat.teamName}
                                </span>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="shrink-0"
                                onClick={() => unarchiveMutation.mutate(chat)}
                                disabled={isUnarchiving}
                                title={t("chat.unarchive")}
                            >
                                {isUnarchiving ? (
                                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
                                )}
                                {t("chat.unarchive")}
                            </Button>
                        </div>
                        {index < chats.length - 1 && <Separator className="mx-3" />}
                    </div>
                );
            })}
            {hasNextPage ? (
                <div className="pt-2">
                    <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => void fetchNextPage()}
                        disabled={isFetchingNextPage}
                    >
                        {isFetchingNextPage ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                        {t("show.more")}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
