"use client";

import { hydrateProjectChatSession, projectChatQueryKey } from "@/components/chat/project-chat-session-query";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

export function usePrefetchProjectChat(projectId: string) {
    const apiClient = useApiClient();
    const queryClient = useQueryClient();

    return useCallback(() => {
        void queryClient.prefetchQuery({
            queryKey: projectChatQueryKey(projectId),
            queryFn: () => hydrateProjectChatSession(apiClient, projectId),
            staleTime: Infinity,
        });
    }, [apiClient, projectId, queryClient]);
}
