import { describe, expect, test } from "vitest";
import { determineProcessStep } from "@/lib/process-step";

describe("determineProcessStep", () => {
    test("does not show failed when failed files are not the majority", () => {
        expect(
            determineProcessStep({
                completed: "2/3",
                failed: "1/3",
            })
        ).toBe("saving");
    });

    test("shows failed when failed files are the majority", () => {
        expect(
            determineProcessStep({
                completed: "1/3",
                failed: "2/3",
            })
        ).toBe("failed");
    });

    test("maps describing progress to generating descriptions", () => {
        expect(
            determineProcessStep({
                describing: "3/3",
                completed: "3/3",
            })
        ).toBe("generating_descriptions");
    });

    test("maps zero-count describing progress to generating descriptions", () => {
        expect(
            determineProcessStep({
                describing: "0/3",
            })
        ).toBe("generating_descriptions");
    });

    test("maps deleting progress to deleting files", () => {
        expect(
            determineProcessStep({
                deleting: "1/2",
            })
        ).toBe("deleting_files");
    });

    test("maps zero-count deleting progress to deleting files", () => {
        expect(
            determineProcessStep({
                deleting: "0/2",
            })
        ).toBe("deleting_files");
    });

    test("switches from completed deleting progress to descriptions", () => {
        expect(
            determineProcessStep({
                deleting: "2/2",
                describing: "1/3",
            })
        ).toBe("generating_descriptions");
    });
});
