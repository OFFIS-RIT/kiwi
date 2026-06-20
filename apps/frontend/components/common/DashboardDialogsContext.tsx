"use client";

import type { Group, Project } from "@/types";
import { createContext, useContext, type ReactNode } from "react";

type DashboardDialogs = {
    editGroup: (group: Group) => void;
    editProject: (project: Project, groupId: string) => void;
};

// Group and project edit dialogs live in DashboardFrame, but the dashboard
// views that surface their "Bearbeiten" affordances (GroupsView, GroupView)
// are rendered as route `{children}` — beyond DashboardFrame's prop reach.
// This context bridges that gap so the cards can open the same dialogs as the
// sidebar instead of getting no-op handlers.
const DashboardDialogsContext = createContext<DashboardDialogs | null>(null);

export function DashboardDialogsProvider({ value, children }: { value: DashboardDialogs; children: ReactNode }) {
    return <DashboardDialogsContext.Provider value={value}>{children}</DashboardDialogsContext.Provider>;
}

export function useDashboardDialogs(): DashboardDialogs {
    const context = useContext(DashboardDialogsContext);
    if (!context) {
        throw new Error("useDashboardDialogs must be used within a DashboardDialogsProvider");
    }
    return context;
}
