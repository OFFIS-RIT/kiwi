"use client";

import { useDashboardDialogs } from "@/components/common/DashboardDialogsContext";
import { GroupList } from "@/components/groups/GroupList";

export function GroupsView() {
    const { editGroup } = useDashboardDialogs();
    return (
        <div className="h-full overflow-y-auto">
            <GroupList onEditGroup={editGroup} />
        </div>
    );
}
