"use client";

import { GroupList } from "@/components/groups/GroupList";

export function GroupsView() {
    return (
        <div className="h-full overflow-y-auto">
            <GroupList />
        </div>
    );
}
