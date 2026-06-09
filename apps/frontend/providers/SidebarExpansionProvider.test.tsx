import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { SidebarExpansionProvider, useSidebarExpansion } from "./SidebarExpansionProvider";

function wrapper({ children }: { children: ReactNode }) {
    return <SidebarExpansionProvider>{children}</SidebarExpansionProvider>;
}

describe("SidebarExpansionProvider", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("expands groups on first visit while tracking graph expansion independently", () => {
        const { result } = renderHook(() => useSidebarExpansion(), { wrapper });

        act(() => {
            result.current.initializeExpandedGroups(["team_1"]);
            result.current.initializeExpandedProjects(["graph_1"]);
        });

        expect(result.current.expandedGroups.team_1).toBe(true);
        expect(result.current.expandedProjects.graph_1).toBe(false);

        act(() => {
            result.current.toggleGroupExpanded("team_1");
        });

        expect(result.current.expandedGroups.team_1).toBe(false);
        expect(result.current.expandedProjects.graph_1).toBe(false);

        act(() => {
            result.current.toggleProjectExpanded("graph_1");
        });

        expect(result.current.expandedGroups.team_1).toBe(false);
        expect(result.current.expandedProjects.graph_1).toBe(true);
    });

    it("respects persisted group expansion and keeps new groups collapsed", () => {
        localStorage.setItem("sidebar-expanded-groups", JSON.stringify({ team_1: false, team_2: true }));

        const { result } = renderHook(() => useSidebarExpansion(), { wrapper });

        act(() => {
            result.current.initializeExpandedGroups(["team_1", "team_2", "team_3"]);
        });

        expect(result.current.expandedGroups).toEqual({
            team_1: false,
            team_2: true,
            team_3: false,
        });
    });

    it("keeps groups collapsed when an empty group expansion state is already stored", () => {
        localStorage.setItem("sidebar-expanded-groups", JSON.stringify({}));

        const { result } = renderHook(() => useSidebarExpansion(), { wrapper });

        act(() => {
            result.current.initializeExpandedGroups(["team_1"]);
        });

        expect(result.current.expandedGroups.team_1).toBe(false);
    });

    it("expands groups and graphs for selected navigation targets", () => {
        const { result } = renderHook(() => useSidebarExpansion(), { wrapper });

        act(() => {
            result.current.initializeExpandedGroups(["team_1"]);
            result.current.initializeExpandedProjects(["graph_1"]);
        });

        act(() => {
            result.current.expandSidebarPath(["team_1"], ["graph_1"]);
        });

        expect(result.current.expandedGroups.team_1).toBe(true);
        expect(result.current.expandedProjects.graph_1).toBe(true);
    });

    it("does not clear stored graph expansion while project data is still empty", () => {
        localStorage.setItem("sidebar-expanded-projects", JSON.stringify({ graph_1: true }));

        const { result } = renderHook(() => useSidebarExpansion(), { wrapper });

        act(() => {
            result.current.initializeExpandedProjects([]);
        });

        expect(JSON.parse(localStorage.getItem("sidebar-expanded-projects") ?? "{}")).toEqual({
            graph_1: true,
        });

        act(() => {
            result.current.initializeExpandedProjects(["graph_1"]);
        });

        expect(result.current.expandedProjects.graph_1).toBe(true);
    });
});
