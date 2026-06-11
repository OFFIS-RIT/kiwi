import { act } from "@testing-library/react";
import { Profiler } from "react";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/use-current-selection", () => ({
    useCurrentSelection: () => ({ group: null, project: null }),
}));

import { renderWithProviders } from "@/test/test-utils";
import { DeleteGroupDialog } from "./DeleteGroupDialog";

describe("DeleteGroupDialog", () => {
    // Regression: resetting the mutation in an effect keyed on the (unstable)
    // useMutation result object caused an endless reset → notify → re-render
    // loop while the dialog was closed, starving route transitions for ~5s.
    test("does not re-render in a loop while closed", async () => {
        let commits = 0;

        renderWithProviders(
            <Profiler id="delete-group-dialog" onRender={() => commits++}>
                <DeleteGroupDialog open={false} onOpenChange={vi.fn()} group={null} />
            </Profiler>
        );

        // Give the TanStack notify scheduler (setTimeout(0) chains) time to
        // sustain the loop if one exists.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
        });

        expect(commits).toBeLessThan(10);
    });
});
