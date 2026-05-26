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

    it("tracks group and graph expansion independently", () => {
        const { result } = renderHook(() => useSidebarExpansion(), { wrapper });

        act(() => {
            result.current.initializeExpandedGroups(["team_1"]);
            result.current.initializeExpandedProjects(["graph_1"]);
        });

        expect(result.current.expandedGroups.team_1).toBe(false);
        expect(result.current.expandedProjects.graph_1).toBe(false);

        act(() => {
            result.current.toggleGroupExpanded("team_1");
        });

        expect(result.current.expandedGroups.team_1).toBe(true);
        expect(result.current.expandedProjects.graph_1).toBe(false);

        act(() => {
            result.current.toggleProjectExpanded("graph_1");
        });

        expect(result.current.expandedGroups.team_1).toBe(true);
        expect(result.current.expandedProjects.graph_1).toBe(true);
    });

    it("temporarily expands groups and graphs for search and restores both states", () => {
        const { result } = renderHook(() => useSidebarExpansion(), { wrapper });

        act(() => {
            result.current.initializeExpandedGroups(["team_1"]);
            result.current.initializeExpandedProjects(["graph_1"]);
        });

        const originalGroups = result.current.expandedGroups;
        const originalProjects = result.current.expandedProjects;

        act(() => {
            result.current.expandGroupsForSearch(["team_1"], ["graph_1"]);
        });

        expect(result.current.expandedGroups.team_1).toBe(true);
        expect(result.current.expandedProjects.graph_1).toBe(true);

        act(() => {
            result.current.restoreExpansionAfterSearch(originalGroups, originalProjects);
        });

        expect(result.current.expandedGroups.team_1).toBe(false);
        expect(result.current.expandedProjects.graph_1).toBe(false);
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
