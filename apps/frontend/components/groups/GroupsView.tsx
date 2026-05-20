"use client";

import { DashboardFrame } from "@/components/common/DashboardFrame";
import { GroupList } from "@/components/groups/GroupList";
import { useGroupsWithProjects } from "@/hooks/use-data";
import { useEffect, useState } from "react";

export function GroupsView() {
    const { isLoading, error } = useGroupsWithProjects();
    const [headerReady, setHeaderReady] = useState(false);

    useEffect(() => {
        if (!isLoading && !error) {
            requestAnimationFrame(() => setHeaderReady(true));
        }
    }, [isLoading, error]);

    return (
        <DashboardFrame headerReady={headerReady}>
            <div className="h-full overflow-y-auto">
                <GroupList />
            </div>
        </DashboardFrame>
    );
}
