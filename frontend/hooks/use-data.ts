"use client";

import { fetchGroups, fetchProjects } from "@/lib/api/groups";
import type {
  ApiBatchStepProgress,
  ApiProjectFile,
  Group,
  ProcessStep,
} from "@/types";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

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
 * - preprocessing + preprocessed → processing_files
 * - extracting → graph_creation
 * - indexing → saving
 * - failed → failed (only if majority)
 *
 * "Completed" is never shown. If only completed files remain, falls back to "saving".
 */
function determineProcessStep(
  progress?: ApiBatchStepProgress,
): ProcessStep | undefined {
  if (!progress) return undefined;

  const queuedCount = parseCount(progress.pending);
  const processingFilesCount =
    parseCount(progress.preprocessing) + parseCount(progress.preprocessed);
  const graphCreationCount = parseCount(progress.extracting);
  const savingCount = parseCount(progress.indexing);
  const failedCount = parseCount(progress.failed);
  const completedCount = parseCount(progress.completed);

  // Active steps ordered by progress (furthest first for tie-breaking)
  const activeStepCounts: { step: ProcessStep; count: number }[] = [
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
  return useQuery({
    queryKey: queryKeys.groupsWithProjects,
    refetchInterval: (query) => {
      const groups = query.state.data as Group[] | undefined;
      const hasActiveProcessing =
        groups?.some((group) =>
          group.projects.some(
            (project) =>
              project.processPercentage !== undefined &&
              project.processPercentage >= 0 &&
              project.processPercentage < 100,
          ),
        ) ?? false;

      return hasActiveProcessing ? 30000 : false;
    },
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const [apiGroups, apiGroupsWithProjects] = await Promise.all([
        fetchGroups(),
        fetchProjects(),
      ]);

      const transformedGroups: Group[] = apiGroups.map((apiGroup) => {
        const groupWithProjects = apiGroupsWithProjects.find(
          (g) => g.group_id === apiGroup.group_id,
        );

        const projects =
          groupWithProjects?.projects?.map((apiProject) => ({
            id: apiProject.project_id.toString(),
            name: apiProject.project_name,
            state: apiProject.project_state,
            processStep: determineProcessStep(apiProject.process_step),
            processProgress: apiProject.process_step,
            processPercentage: apiProject.process_percentage,
            processEstimatedDuration: apiProject.process_estimated_duration,
            processTimeRemaining: apiProject.process_time_remaining,
          })) || [];

        return {
          id: apiGroup.group_id.toString(),
          name: apiGroup.group_name,
          projects,
        };
      });

      return transformedGroups;
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
  return useSuspenseQuery({
    queryKey: queryKeys.groupsWithProjects,
    refetchInterval: (query) => {
      const groups = query.state.data as Group[] | undefined;
      const hasActiveProcessing =
        groups?.some((group) =>
          group.projects.some(
            (project) =>
              project.processPercentage !== undefined &&
              project.processPercentage >= 0 &&
              project.processPercentage < 100,
          ),
        ) ?? false;

      return hasActiveProcessing ? 30000 : false;
    },
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const [apiGroups, apiGroupsWithProjects] = await Promise.all([
        fetchGroups(),
        fetchProjects(),
      ]);

      const transformedGroups: Group[] = apiGroups.map((apiGroup) => {
        const groupWithProjects = apiGroupsWithProjects.find(
          (g) => g.group_id === apiGroup.group_id,
        );

        const projects =
          groupWithProjects?.projects?.map((apiProject) => ({
            id: apiProject.project_id.toString(),
            name: apiProject.project_name,
            state: apiProject.project_state,
            processStep: determineProcessStep(apiProject.process_step),
            processProgress: apiProject.process_step,
            processPercentage: apiProject.process_percentage,
            processEstimatedDuration: apiProject.process_estimated_duration,
            processTimeRemaining: apiProject.process_time_remaining,
          })) || [];

        return {
          id: apiGroup.group_id.toString(),
          name: apiGroup.group_name,
          projects,
        };
      });

      return transformedGroups;
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
      users?: { user_id: number; role: string }[];
    }) => {
      const { updateGroup } = await import("@/lib/api");
      return updateGroup(groupId, name, users);
    },
    onMutate: async ({ groupId, name }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.groupsWithProjects,
      });

      const previousGroups = queryClient.getQueryData<Group[]>(
        queryKeys.groupsWithProjects,
      );

      queryClient.setQueryData<Group[]>(
        queryKeys.groupsWithProjects,
        (old) =>
          old?.map((group) =>
            group.id === groupId ? { ...group, name } : group,
          ) || [],
      );

      return { previousGroups };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousGroups) {
        queryClient.setQueryData(
          queryKeys.groupsWithProjects,
          context.previousGroups,
        );
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

      const previousGroups = queryClient.getQueryData<Group[]>(
        queryKeys.groupsWithProjects,
      );

      queryClient.setQueryData<Group[]>(
        queryKeys.groupsWithProjects,
        (old) => old?.filter((group) => group.id !== groupId) || [],
      );

      return { previousGroups };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousGroups) {
        queryClient.setQueryData(
          queryKeys.groupsWithProjects,
          context.previousGroups,
        );
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
    mutationFn: async ({
      groupId,
      name,
      files = [],
    }: {
      groupId: string;
      name: string;
      files?: File[];
    }) => {
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
    mutationFn: async ({
      projectId,
      name,
    }: {
      projectId: string;
      name: string;
    }) => {
      const { updateProject } = await import("@/lib/api");
      return updateProject(projectId, name);
    },
    onMutate: async ({ projectId, name }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.groupsWithProjects,
      });

      const previousGroups = queryClient.getQueryData<Group[]>(
        queryKeys.groupsWithProjects,
      );

      queryClient.setQueryData<Group[]>(
        queryKeys.groupsWithProjects,
        (old) =>
          old?.map((group) => ({
            ...group,
            projects: group.projects.map((project) =>
              project.id === projectId ? { ...project, name } : project,
            ),
          })) || [],
      );

      return { previousGroups };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousGroups) {
        queryClient.setQueryData(
          queryKeys.groupsWithProjects,
          context.previousGroups,
        );
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

      const previousGroups = queryClient.getQueryData<Group[]>(
        queryKeys.groupsWithProjects,
      );

      queryClient.setQueryData<Group[]>(
        queryKeys.groupsWithProjects,
        (old) =>
          old?.map((group) => ({
            ...group,
            projects: group.projects.filter(
              (project) => project.id !== projectId,
            ),
          })) || [],
      );

      return { previousGroups };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousGroups) {
        queryClient.setQueryData(
          queryKeys.groupsWithProjects,
          context.previousGroups,
        );
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
export function useProjectFiles(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectFiles(projectId),
    queryFn: async () => {
      const { fetchProjectFiles } = await import("@/lib/api");
      return fetchProjectFiles(projectId);
    },
    enabled: !!projectId,
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
    mutationFn: async ({
      projectId,
      fileKeys,
    }: {
      projectId: string;
      fileKeys: string[];
    }) => {
      const { deleteProjectFiles } = await import("@/lib/api");
      return deleteProjectFiles(projectId, fileKeys);
    },
    onMutate: async ({ projectId, fileKeys }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.projectFiles(projectId),
      });

      const previousFiles = queryClient.getQueryData<ApiProjectFile[]>(
        queryKeys.projectFiles(projectId),
      );

      queryClient.setQueryData<ApiProjectFile[]>(
        queryKeys.projectFiles(projectId),
        (old) => old?.filter((file) => !fileKeys.includes(file.file_key)) || [],
      );

      return { previousFiles, projectId };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousFiles && context.projectId) {
        queryClient.setQueryData(
          queryKeys.projectFiles(context.projectId),
          context.previousFiles,
        );
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
