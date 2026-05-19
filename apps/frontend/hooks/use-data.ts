"use client";

import {
    addFilesToProject,
    createGroup,
    createProject,
    deleteGroup,
    deleteProject,
    deleteProjectFiles,
    fetchGraphs,
    fetchGroups,
    fetchProjectFiles,
    updateGroup,
    updateProject,
} from "@/lib/api";
import { determineProcessStep } from "@/lib/process-step";
import { useApiClient } from "@/providers/ApiClientProvider";
import type { ApiBatchStepProgress, ApiGraph, ApiGroup, ApiProjectFile, Group } from "@/types";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";

function hasActiveProcessing(groups?: Group[]): boolean {
    return (
        groups?.some((group) =>
            group.projects.some(
                (project) =>
                    project.state !== "ready" ||
                    (project.processPercentage !== undefined &&
                        project.processPercentage >= 0 &&
                        project.processPercentage < 100)
            )
        ) ?? false
    );
}

function hasProcessingFiles(files?: ApiProjectFile[]): boolean {
    return files?.some((file) => file.status === "processing") ?? false;
}

function transformGroupsWithGraphs(apiGroups: ApiGroup[], apiGraphs: ApiGraph[]): Group[] {
    return apiGroups.map((apiGroup) => {
        const projects = apiGraphs
            .filter((apiGraph) => apiGraph.group_id === apiGroup.group_id)
            .map((apiGraph) => ({
                id: apiGraph.graph_id,
                name: apiGraph.graph_name,
                state: apiGraph.graph_state,
                processStep: determineProcessStep(apiGraph.process_step as ApiBatchStepProgress | undefined),
                processProgress: apiGraph.process_step as ApiBatchStepProgress | undefined,
                processPercentage: apiGraph.process_percentage ?? (apiGraph.graph_state === "update" ? 0 : undefined),
                processEstimatedDuration: apiGraph.process_estimated_duration,
                processTimeRemaining: apiGraph.process_time_remaining,
            }));

        return {
            id: apiGroup.group_id,
            name: apiGroup.group_name,
            projects,
        };
    });
}

/**
 * Centralized query keys for React Query cache management.
 * Use these keys to ensure consistent cache invalidation across the application.
 */
export const queryKeys = {
    groups: ["groups"] as const,
    projects: ["projects"] as const,
    groupsWithProjects: ["groups", "with-projects"] as const,
    projectFiles: (projectId: string) => ["project-files", projectId] as const,
};

/**
 * Fetches all groups with their associated projects, transforming API data to domain models.
 * Combines data from both groups and projects endpoints in parallel for efficiency.
 *
 * @returns Query result containing transformed Group array with nested Project objects
 */
export function useGroupsWithProjects() {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();

    return useQuery({
        queryKey: queryKeys.groupsWithProjects,
        refetchInterval: (query) => {
            const groups = query.state.data as Group[] | undefined;
            return hasActiveProcessing(groups) ? 5000 : false;
        },
        refetchIntervalInBackground: false,
        queryFn: async () => {
            const cachedGroups = queryClient.getQueryData<ApiGroup[]>(queryKeys.groups);
            const [apiGroups, apiGraphs] = await Promise.all([
                cachedGroups ?? fetchGroups(apiClient),
                fetchGraphs(apiClient),
            ]);

            if (!cachedGroups) {
                queryClient.setQueryData(queryKeys.groups, apiGroups);
            }

            return transformGroupsWithGraphs(apiGroups, apiGraphs);
        },
    });
}

/**
 * Suspense-enabled version of {@link useGroupsWithProjects}.
 * Throws a promise during loading, allowing React Suspense to handle loading states.
 * Use this when the component is wrapped in a Suspense boundary.
 *
 * @returns Query result (never in loading state due to suspense behavior)
 */
export function useGroupsWithProjectsSuspense() {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();

    return useSuspenseQuery({
        queryKey: queryKeys.groupsWithProjects,
        refetchInterval: (query) => {
            const groups = query.state.data as Group[] | undefined;
            return hasActiveProcessing(groups) ? 5000 : false;
        },
        refetchIntervalInBackground: false,
        queryFn: async () => {
            const cachedGroups = queryClient.getQueryData<ApiGroup[]>(queryKeys.groups);
            const [apiGroups, apiGraphs] = await Promise.all([
                cachedGroups ?? fetchGroups(apiClient),
                fetchGraphs(apiClient),
            ]);

            if (!cachedGroups) {
                queryClient.setQueryData(queryKeys.groups, apiGroups);
            }

            return transformGroupsWithGraphs(apiGroups, apiGraphs);
        },
    });
}

/**
 * Creates a new group and invalidates related queries on success.
 *
 * @returns Mutation object with mutate/mutateAsync functions
 */
export function useCreateGroup() {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();

    return useMutation({
        mutationFn: (name: string) => createGroup(apiClient, name),
        onSuccess: () => {
            queryClient.removeQueries({ queryKey: queryKeys.groups, exact: true });
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
        },
    });
}

/**
 * Updates a group with optimistic UI updates.
 * Immediately reflects changes in the UI, then syncs with server.
 * Automatically rolls back on error.
 *
 * @returns Mutation object with mutate/mutateAsync functions
 */
export function useUpdateGroup() {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();

    return useMutation({
        mutationFn: ({
            groupId,
            name,
            users = [],
        }: {
            groupId: string;
            name: string;
            users?: { user_id: string; role: string }[];
        }) => updateGroup(apiClient, groupId, name, users),
        onMutate: async ({ groupId, name }) => {
            await queryClient.cancelQueries({
                queryKey: queryKeys.groupsWithProjects,
            });

            const previousGroups = queryClient.getQueryData<Group[]>(queryKeys.groupsWithProjects);

            queryClient.setQueryData<Group[]>(
                queryKeys.groupsWithProjects,
                (old) => old?.map((group) => (group.id === groupId ? { ...group, name } : group)) || []
            );

            return { previousGroups };
        },
        onError: (_err, _variables, context) => {
            if (context?.previousGroups) {
                queryClient.setQueryData(queryKeys.groupsWithProjects, context.previousGroups);
            }
        },
        onSuccess: () => {
            queryClient.removeQueries({ queryKey: queryKeys.groups, exact: true });
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
        },
    });
}

/**
 * Deletes a group with optimistic UI updates.
 * Removes the group from cache immediately, rolls back on error.
 *
 * @returns Mutation object with mutate/mutateAsync functions
 */
export function useDeleteGroup() {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();

    return useMutation({
        mutationFn: (groupId: string) => deleteGroup(apiClient, groupId),
        onMutate: async (groupId) => {
            await queryClient.cancelQueries({
                queryKey: queryKeys.groupsWithProjects,
            });

            const previousGroups = queryClient.getQueryData<Group[]>(queryKeys.groupsWithProjects);

            queryClient.setQueryData<Group[]>(
                queryKeys.groupsWithProjects,
                (old) => old?.filter((group) => group.id !== groupId) || []
            );

            return { previousGroups };
        },
        onError: (_err, _variables, context) => {
            if (context?.previousGroups) {
                queryClient.setQueryData(queryKeys.groupsWithProjects, context.previousGroups);
            }
        },
        onSuccess: () => {
            queryClient.removeQueries({ queryKey: queryKeys.groups, exact: true });
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
        },
    });
}

/**
 * Creates a new project within a group, optionally with initial files.
 *
 * @returns Mutation object with mutate/mutateAsync functions
 */
export function useCreateProject() {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();

    return useMutation({
        mutationFn: ({ groupId, name, files = [] }: { groupId: string; name: string; files?: File[] }) =>
            createProject(apiClient, groupId, name, files),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
        },
    });
}

/**
 * Updates a project with optimistic UI updates.
 * Immediately reflects name changes in the UI, rolls back on error.
 *
 * @returns Mutation object with mutate/mutateAsync functions
 */
export function useUpdateProject() {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();

    return useMutation({
        mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
            updateProject(apiClient, projectId, name),
        onMutate: async ({ projectId, name }) => {
            await queryClient.cancelQueries({
                queryKey: queryKeys.groupsWithProjects,
            });

            const previousGroups = queryClient.getQueryData<Group[]>(queryKeys.groupsWithProjects);

            queryClient.setQueryData<Group[]>(
                queryKeys.groupsWithProjects,
                (old) =>
                    old?.map((group) => ({
                        ...group,
                        projects: group.projects.map((project) =>
                            project.id === projectId ? { ...project, name } : project
                        ),
                    })) || []
            );

            return { previousGroups };
        },
        onError: (_err, _variables, context) => {
            if (context?.previousGroups) {
                queryClient.setQueryData(queryKeys.groupsWithProjects, context.previousGroups);
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
        },
    });
}

/**
 * Deletes a project with optimistic UI updates.
 * Removes the project from cache immediately, rolls back on error.
 *
 * @returns Mutation object with mutate/mutateAsync functions
 */
export function useDeleteProject() {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();

    return useMutation({
        mutationFn: (projectId: string) => deleteProject(apiClient, projectId),
        onMutate: async (projectId) => {
            await queryClient.cancelQueries({
                queryKey: queryKeys.groupsWithProjects,
            });

            const previousGroups = queryClient.getQueryData<Group[]>(queryKeys.groupsWithProjects);

            queryClient.setQueryData<Group[]>(
                queryKeys.groupsWithProjects,
                (old) =>
                    old?.map((group) => ({
                        ...group,
                        projects: group.projects.filter((project) => project.id !== projectId),
                    })) || []
            );

            return { previousGroups };
        },
        onError: (_err, _variables, context) => {
            if (context?.previousGroups) {
                queryClient.setQueryData(queryKeys.groupsWithProjects, context.previousGroups);
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
        },
    });
}

/**
 * Fetches files associated with a specific project.
 * Query is disabled when projectId is empty/falsy.
 *
 * @param projectId - The project identifier
 * @returns Query result containing array of project files
 */
export function useProjectFiles(projectId: string, options?: { enabled?: boolean }) {
    const apiClient = useApiClient();

    return useQuery({
        queryKey: queryKeys.projectFiles(projectId),
        queryFn: () => fetchProjectFiles(apiClient, projectId),
        enabled: (options?.enabled ?? true) && !!projectId,
        refetchInterval: (query) => {
            const files = query.state.data as ApiProjectFile[] | undefined;
            return hasProcessingFiles(files) ? 5000 : false;
        },
    });
}

/**
 * Uploads files to an existing project.
 * Invalidates project files and groups queries on success.
 *
 * @returns Mutation object with mutate/mutateAsync functions
 */
export function useUploadProjectFiles() {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();

    return useMutation({
        mutationFn: ({
            projectId,
            files,
            onProgress,
        }: {
            projectId: string;
            files: File[];
            onProgress?: (progress: number) => void;
        }) => addFilesToProject(apiClient, projectId, files, onProgress),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.projectFiles(variables.projectId),
            });
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
        },
    });
}

/**
 * Deletes files from a project with optimistic UI updates.
 * Removes files from cache immediately, rolls back on error.
 *
 * @returns Mutation object with mutate/mutateAsync functions
 */
export function useDeleteProjectFiles() {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();

    return useMutation({
        mutationFn: ({ projectId, fileKeys }: { projectId: string; fileKeys: string[] }) =>
            deleteProjectFiles(apiClient, projectId, fileKeys),
        onMutate: async ({ projectId, fileKeys }) => {
            await queryClient.cancelQueries({
                queryKey: queryKeys.projectFiles(projectId),
            });

            const previousFiles = queryClient.getQueryData<ApiProjectFile[]>(queryKeys.projectFiles(projectId));

            queryClient.setQueryData<ApiProjectFile[]>(
                queryKeys.projectFiles(projectId),
                (old) => old?.filter((file) => !fileKeys.includes(file.file_key)) || []
            );

            return { previousFiles, projectId };
        },
        onError: (_err, _variables, context) => {
            if (context?.previousFiles && context.projectId) {
                queryClient.setQueryData(queryKeys.projectFiles(context.projectId), context.previousFiles);
            }
        },
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.projectFiles(variables.projectId),
            });
            queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
        },
    });
}
