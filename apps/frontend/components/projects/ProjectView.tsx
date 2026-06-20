"use client";

import { ProjectChat } from "@/components/chat";
import { useGroupsWithProjects } from "@/hooks/use-data";
import { notFound, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

type ProjectViewProps = {
    groupId: string;
    projectId: string;
};

export function ProjectView({ groupId, projectId }: ProjectViewProps) {
    const router = useRouter();
    const { data: groups = [], isLoading, isFetching } = useGroupsWithProjects();
    const everGroupExistedRef = useRef(false);
    const everProjectExistedRef = useRef(false);
    const seenGroupIdRef = useRef<string | null>(null);
    const seenProjectIdRef = useRef<string | null>(null);

    // Reset the "have we seen this" flags when the route ids change, so moving
    // to an unknown id doesn't inherit a previous entity's existence.
    if (seenGroupIdRef.current !== groupId) {
        seenGroupIdRef.current = groupId;
        everGroupExistedRef.current = false;
    }
    if (seenProjectIdRef.current !== projectId) {
        seenProjectIdRef.current = projectId;
        everProjectExistedRef.current = false;
    }

    const group = groups.find((item) => item.id === groupId);
    const project = group?.projects.find((item) => item.id === projectId);
    if (group) {
        everGroupExistedRef.current = true;
    }
    if (project) {
        everProjectExistedRef.current = true;
    }

    // Also wait for background refetches to settle (isFetching), not just the
    // initial load — otherwise a stale-cache refetch could 404 an entity the
    // server is about to return.
    const groupMissing = !isLoading && !isFetching && !group;
    const projectMissing = !isLoading && !isFetching && !!group && !project;

    useEffect(() => {
        // A group/project we had already seen vanished — it was deleted, so
        // navigate to the parent. Unknown ids are handled by notFound() below.
        if (groupMissing && everGroupExistedRef.current) {
            router.replace("/");
        } else if (projectMissing && everProjectExistedRef.current) {
            router.replace(`/${groupId}`);
        }
    }, [groupMissing, projectMissing, groupId, router]);

    // Unknown ids → not-found. Keep this a render-phase throw, NOT an effect:
    // throwing during render aborts the commit so the redirect effect above
    // never schedules, keeping the redirect and not-found paths mutually
    // exclusive.
    if ((groupMissing && !everGroupExistedRef.current) || (projectMissing && !everProjectExistedRef.current)) {
        notFound();
    }

    return (
        <div className="h-full min-w-0 overflow-hidden">
            {group && project ? (
                <ProjectChat projectName={project.name} groupName={group.name} projectId={project.id} />
            ) : null}
        </div>
    );
}
