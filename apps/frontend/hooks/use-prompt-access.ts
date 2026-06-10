"use client";

import { useGroupsWithProjects } from "@/hooks/use-data";
import { canManageGroupPromptsInGroup } from "@/lib/capabilities";
import { useAuth } from "@/providers/AuthProvider";
import { useMemo } from "react";

/**
 * Lists the groups whose Prompts (Team Prompt and the projects' Graph
 * Prompts) the current user may manage, derived from the cached groups query
 * and the prompt capability. Personal projects never appear in the Group
 * domain model, so they are excluded by construction.
 */
export function useManageablePromptGroups() {
    const { isAdmin, isSystemAdmin } = useAuth();
    const { data: groups = [], isLoading } = useGroupsWithProjects();

    const manageableGroups = useMemo(
        () => groups.filter((group) => canManageGroupPromptsInGroup(group, { isAdmin, isSystemAdmin })),
        [groups, isAdmin, isSystemAdmin]
    );

    return { groups: manageableGroups, isLoading };
}

/**
 * Whether the current user may see the Prompts settings Section. System
 * admins always can (the Organization Prompt is theirs even when no group is
 * listed); everyone else needs at least one manageable group. UX only — the
 * API enforces the permission per request.
 */
export function useCanManagePrompts() {
    const { isSystemAdmin } = useAuth();
    const { groups, isLoading } = useManageablePromptGroups();

    return {
        canManagePrompts: isSystemAdmin || groups.length > 0,
        isLoading: isSystemAdmin ? false : isLoading,
    };
}
