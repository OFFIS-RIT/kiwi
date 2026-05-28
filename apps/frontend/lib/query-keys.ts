export const queryKeys = {
    groups: ["groups"] as const,
    projects: ["projects"] as const,
    groupsWithProjects: ["groups", "with-projects"] as const,
    projectChats: (projectId: string) => ["project-chats", projectId] as const,
    projectFiles: (projectId: string) => ["project-files", projectId] as const,
    search: (query: string) => ["search", query] as const,
};
