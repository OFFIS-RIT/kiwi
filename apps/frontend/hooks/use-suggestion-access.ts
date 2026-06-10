"use client";

import { useGroupsWithProjects } from "@/hooks/use-data";
import { canManageGraphSuggestionsInGroup } from "@/lib/capabilities";
import { useAuth } from "@/providers/AuthProvider";
import { useMemo } from "react";

export type ManageableSuggestionProject = {
    projectId: string;
    projectName: string;
    groupName: string;
};

/**
 * Lists the projects whose graph suggestions the current user may manage,
 * derived from the cached groups query and the suggestion capability.
 */
export function useManageableSuggestionProjects() {
    const { isAdmin } = useAuth();
    const { data: groups = [], isLoading } = useGroupsWithProjects();

    const projects = useMemo<ManageableSuggestionProject[]>(
        () =>
            groups
                .filter((group) => canManageGraphSuggestionsInGroup(group, { isAdmin }))
                .flatMap((group) =>
                    group.projects.map((project) => ({
                        projectId: project.id,
                        projectName: project.name,
                        groupName: group.name,
                    }))
                ),
        [groups, isAdmin]
    );

    return { projects, isLoading };
}

/**
 * Whether the current user may manage graph suggestions for at least one
 * group. Gates the Administration settings Category — UX only, the API
 * enforces the permission per request.
 */
export function useCanManageSuggestions() {
    const { isAdmin } = useAuth();
    const { data: groups = [] } = useGroupsWithProjects();

    return groups.some((group) => canManageGraphSuggestionsInGroup(group, { isAdmin }));
}
