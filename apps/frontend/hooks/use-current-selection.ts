"use client";

import { useParams } from "next/navigation";

import { useGroupsWithProjects } from "@/hooks/use-data";

export function useCurrentSelection() {
    const { groupId, projectId } = useParams<{ groupId?: string; projectId?: string }>();
    const { data: groups = [] } = useGroupsWithProjects();

    const group = groupId ? (groups.find((g) => g.id === groupId) ?? null) : null;
    const project = group && projectId ? (group.projects.find((p) => p.id === projectId) ?? null) : null;

    return { group, project };
}
