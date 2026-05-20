"use client";

import { ProjectChat } from "@/components/chat";
import { DashboardFrame } from "@/components/common/DashboardFrame";
import { useGroupsWithProjects } from "@/hooks/use-data";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type ProjectViewProps = {
    groupId: string;
    projectId: string;
};

export function ProjectView({ groupId, projectId }: ProjectViewProps) {
    const router = useRouter();
    const { data: groups = [], isLoading, error } = useGroupsWithProjects();
    const [headerReady, setHeaderReady] = useState(false);
    const processingProjectIdsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!isLoading && !error) {
            requestAnimationFrame(() => setHeaderReady(true));
        }
    }, [isLoading, error]);

    useEffect(() => {
        const processingProjectIds = processingProjectIdsRef.current;
        for (const group of groups) {
            for (const project of group.projects) {
                if (project.state !== "ready") {
                    processingProjectIds.add(project.id);
                } else {
                    processingProjectIds.delete(project.id);
                }
            }
        }
    }, [groups]);

    const group = groups.find((item) => item.id === groupId);
    const project = group?.projects.find((item) => item.id === projectId);

    useEffect(() => {
        if (isLoading) return;
        if (!group) {
            router.replace("/");
            return;
        }
        if (!project && !processingProjectIdsRef.current.has(projectId)) {
            router.replace(`/${group.id}`);
        }
    }, [group, isLoading, project, projectId, router]);

    return (
        <DashboardFrame headerReady={headerReady}>
            <div className="h-full min-w-0 overflow-hidden">
                {group && project ? (
                    <ProjectChat projectName={project.name} groupName={group.name} projectId={project.id} />
                ) : null}
            </div>
        </DashboardFrame>
    );
}
