"use client";

import { fetchGraphs, fetchGroups } from "@/lib/api/groups";
import type { ApiBatchStepProgress, ApiGraph, ApiGroup, ApiProjectFile, Group, ProcessStep } from "@/types";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";

/**
 * Parses a string count to a number, defaulting to 0.
 */
function parseCount(value?: string): number {
    if (!value) return 0;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? 0 : parsed;
}

/**
 * Determines the current process step based on the step with the highest file count.
 * Steps are aggregated as follows:
 * - pending → queued (shown if no active processing steps)
 * - preprocessing + metadata + chunking → processing_files
 * - extracting + deduplicating → graph_creation
 * - saving → saving
 * - describing → generating_descriptions
 * - failed → failed (only if majority)
 *
 * "Completed" is never shown. If only completed files remain, falls back to "saving".
 */
function determineProcessStep(progress?: ApiBatchStepProgress): ProcessStep | undefined {
    if (!progress) return undefined;

    const queuedCount = parseCount(progress.pending);
    const processingFilesCount =
        parseCount(progress.preprocessing) + parseCount(progress.metadata) + parseCount(progress.chunking);
    const graphCreationCount = parseCount(progress.extracting) + parseCount(progress.deduplicating);
    const savingCount = parseCount(progress.saving);
    const describingCount = parseCount(progress.describing);
    const failedCount = parseCount(progress.failed);
    const completedCount = parseCount(progress.completed);

    // Active steps ordered by progress (furthest first for tie-breaking)
    const activeStepCounts: { step: ProcessStep; count: number }[] = [
        { step: "generating_descriptions", count: describingCount },
        { step: "saving", count: savingCount },
        { step: "graph_creation", count: graphCreationCount },
        { step: "processing_files", count: processingFilesCount },
        { step: "failed", count: failedCount },
    ];

    // Find the step with the highest count (furthest step wins ties)
    let maxStep: ProcessStep | undefined = undefined;
    let maxCount = 0;

    for (const { step, count } of activeStepCounts) {
        if (count > maxCount) {
            maxCount = count;
            maxStep = step;
        }
    }

    // If there's an active step, show it
    if (maxStep) {
        return maxStep;
    }

    // Show "queued" if files are waiting and no active processing
    if (queuedCount > 0) {
        return "queued";
    }

    // If only completed files remain, show "saving" as fallback
    if (completedCount > 0) {
        return "saving";
    }

    return undefined;
}

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
                processEtaConfidence: apiGraph.process_eta_confidence,
                processEtaSampleCount: apiGraph.process_eta_sample_count,
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
 * Fetches all groups without their associated projects.
 * For groups with projects included, use {@link useGroupsWithProjects} instead.
 *
 * @returns Query result containing an array of groups
 */
export function useGroups() {
    return useQuery({
        queryKey: queryKeys.groups,
        queryFn: async () => {
            const groups = await fetchGroups();
            return groups;
        },
    });
}

/**
 * Fetches all groups with their associated projects, transforming API data to domain models.
 * Combines data from both groups and projects endpoints in parallel for efficiency.
 *
 * @returns Query result containing transformed Group array with nested Project objects
 */
export function useGroupsWithProjects() {
    const queryClient = useQueryClient();

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
                cachedGroups ?? fetchGroups(),
                fetchGraphs(),
            ]);

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
                cachedGroups ?? fetchGroups(),
                fetchGraphs(),
            ]);

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

    return useMutation({
        mutationFn: async (name: string) => {
            const { createGroup } = await import("@/lib/api");
            return createGroup(name);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.groups });
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

    return useMutation({
        mutationFn: async ({
            groupId,
            name,
            users = [],
        }: {
            groupId: string;
            name: string;
            users?: { user_id: string; role: string }[];
        }) => {
            const { updateGroup } = await import("@/lib/api");
            return updateGroup(groupId, name, users);
        },
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
            queryClient.invalidateQueries({ queryKey: queryKeys.groups });
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

    return useMutation({
        mutationFn: async (groupId: string) => {
            const { deleteGroup } = await import("@/lib/api");
            return deleteGroup(groupId);
        },
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
            queryClient.invalidateQueries({ queryKey: queryKeys.groups });
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

    return useMutation({
        mutationFn: async ({ groupId, name, files = [] }: { groupId: string; name: string; files?: File[] }) => {
            const { createProject } = await import("@/lib/api");
            return createProject(groupId, name, files);
        },
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

    return useMutation({
        mutationFn: async ({ projectId, name }: { projectId: string; name: string }) => {
            const { updateProject } = await import("@/lib/api");
            return updateProject(projectId, name);
        },
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

    return useMutation({
        mutationFn: async (projectId: string) => {
            const { deleteProject } = await import("@/lib/api");
            return deleteProject(projectId);
        },
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
    return useQuery({
        queryKey: queryKeys.projectFiles(projectId),
        queryFn: async () => {
            const { fetchProjectFiles } = await import("@/lib/api");
            return fetchProjectFiles(projectId);
        },
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

    return useMutation({
        mutationFn: async ({
            projectId,
            files,
            onProgress,
        }: {
            projectId: string;
            files: File[];
            onProgress?: (progress: number) => void;
        }) => {
            const { addFilesToProject } = await import("@/lib/api");
            return addFilesToProject(projectId, files, onProgress);
        },
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

    return useMutation({
        mutationFn: async ({ projectId, fileKeys }: { projectId: string; fileKeys: string[] }) => {
            const { deleteProjectFiles } = await import("@/lib/api");
            return deleteProjectFiles(projectId, fileKeys);
        },
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
