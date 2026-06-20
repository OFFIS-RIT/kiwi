"use client";

import { ProjectList } from "@/components/projects";
import { useDashboardDialogs } from "@/components/common/DashboardDialogsContext";
import { useGroupsWithProjects } from "@/hooks/use-data";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { notFound, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

type GroupViewProps = {
    groupId: string;
};

export function GroupView({ groupId }: GroupViewProps) {
    const router = useRouter();
    const t = useAppTranslations();
    const { editProject } = useDashboardDialogs();
    const { data: groups = [], isLoading, isFetching } = useGroupsWithProjects();
    const everExistedRef = useRef(false);
    const seenGroupIdRef = useRef<string | null>(null);

    // Reset "have we seen this group" when the route id changes, so navigating
    // from a real group to an unknown id doesn't inherit the previous group's
    // existence.
    if (seenGroupIdRef.current !== groupId) {
        seenGroupIdRef.current = groupId;
        everExistedRef.current = false;
    }

    const group = groups.find((item) => item.id === groupId);
    if (group) {
        everExistedRef.current = true;
    }

    // Wait for both the initial load and any background refetch to settle:
    // React Query keeps isLoading=false while isFetching=true during a stale
    // refetch, so checking only isLoading could 404 an entity that the refetch
    // is about to return (e.g. a group the user was just added to).
    const isMissing = !isLoading && !isFetching && !group;

    useEffect(() => {
        // A group we had already seen vanished — it was deleted. Go home rather
        // than showing a not-found page.
        if (isMissing && everExistedRef.current) {
            router.replace("/");
        }
    }, [isMissing, router]);

    // An id we've never seen that isn't in the list is unknown — surface the
    // not-found page instead of silently falling back to the dashboard.
    if (isMissing && !everExistedRef.current) {
        notFound();
    }

    return (
        <div className="h-full overflow-y-auto">
            {group ? (
                <ProjectList onEditProject={editProject} />
            ) : (
                <div className="flex h-full items-center justify-center">
                    <div className="text-center">
                        <h2 className="text-xl font-semibold">{t("no.group.selected")}</h2>
                        <p className="text-muted-foreground">{t("select.group.sidebar")}</p>
                    </div>
                </div>
            )}
        </div>
    );
}
