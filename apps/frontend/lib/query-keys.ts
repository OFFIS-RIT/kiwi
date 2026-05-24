export const queryKeys = {
    groups: ["groups"] as const,
    projects: ["projects"] as const,
    groupsWithProjects: ["groups", "with-projects"] as const,
    projectFiles: (projectId: string) => ["project-files", projectId] as const,
};
