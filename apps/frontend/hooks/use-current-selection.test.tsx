import { renderHook } from "@testing-library/react";
import { useParams } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

import { useGroupsWithProjects } from "@/hooks/use-data";

import { useCurrentSelection } from "./use-current-selection";

vi.mock("next/navigation", () => ({ useParams: vi.fn() }));
vi.mock("@/hooks/use-data", () => ({ useGroupsWithProjects: vi.fn() }));

const fakeGroups = [{ id: "g1", name: "G1", projects: [{ id: "p1", name: "P1", state: "ready" as const }] }];

describe("useCurrentSelection", () => {
    it("returns null/null when no params", () => {
        vi.mocked(useParams).mockReturnValue({});
        vi.mocked(useGroupsWithProjects).mockReturnValue({ data: fakeGroups } as never);
        const { result } = renderHook(() => useCurrentSelection());
        expect(result.current).toEqual({ group: null, project: null });
    });

    it("returns group when groupId matches", () => {
        vi.mocked(useParams).mockReturnValue({ groupId: "g1" });
        vi.mocked(useGroupsWithProjects).mockReturnValue({ data: fakeGroups } as never);
        const { result } = renderHook(() => useCurrentSelection());
        expect(result.current.group?.id).toBe("g1");
        expect(result.current.project).toBeNull();
    });

    it("returns both when both match", () => {
        vi.mocked(useParams).mockReturnValue({ groupId: "g1", projectId: "p1" });
        vi.mocked(useGroupsWithProjects).mockReturnValue({ data: fakeGroups } as never);
        const { result } = renderHook(() => useCurrentSelection());
        expect(result.current.group?.id).toBe("g1");
        expect(result.current.project?.id).toBe("p1");
    });

    it("returns null group when groupId not found", () => {
        vi.mocked(useParams).mockReturnValue({ groupId: "unknown" });
        vi.mocked(useGroupsWithProjects).mockReturnValue({ data: fakeGroups } as never);
        const { result } = renderHook(() => useCurrentSelection());
        expect(result.current.group).toBeNull();
    });
});
