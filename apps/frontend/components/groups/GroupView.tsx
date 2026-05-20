"use client";

import { DashboardFrame } from "@/components/common/DashboardFrame";
import { ProjectList } from "@/components/projects";
import { useData } from "@/providers/DataProvider";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type GroupViewProps = {
    groupId: string;
};

export function GroupView({ groupId }: GroupViewProps) {
    const router = useRouter();
    const t = useTranslations();
    const { groups, isLoading, error } = useData();
    const [headerReady, setHeaderReady] = useState(false);
    const processingGroupIdsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!isLoading && !error) {
            requestAnimationFrame(() => setHeaderReady(true));
        }
    }, [isLoading, error]);

    useEffect(() => {
        const processingGroupIds = processingGroupIdsRef.current;
        processingGroupIds.clear();
        for (const group of groups) {
            if (group.projects.some((project) => project.state !== "ready")) {
                processingGroupIds.add(group.id);
            }
        }
    }, [groups]);

    useEffect(() => {
        if (isLoading) return;
        const group = groups.find((item) => item.id === groupId);
        if (!group && !processingGroupIdsRef.current.has(groupId)) {
            router.replace("/");
        }
    }, [groupId, groups, isLoading, router]);

    const group = groups.find((item) => item.id === groupId);

    return (
        <DashboardFrame headerReady={headerReady}>
            <div className="h-full overflow-y-auto">
                {group ? (
                    <ProjectList />
                ) : (
                    <div className="flex h-full items-center justify-center">
                        <div className="text-center">
                            <h2 className="text-xl font-semibold">{t("no.group.selected")}</h2>
                            <p className="text-muted-foreground">{t("select.group.sidebar")}</p>
                        </div>
                    </div>
                )}
            </div>
        </DashboardFrame>
    );
}
