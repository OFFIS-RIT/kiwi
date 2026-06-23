import { describe, expect, test } from "bun:test";
import { buildDeleteStepProgress, buildProcessPercentage, buildProcessStepProgress } from "../process-progress";

describe("buildProcessStepProgress", () => {
    test("returns undefined for an empty file list", () => {
        expect(buildProcessStepProgress({ status: "started" }, [])).toBeUndefined();
    });

    test("returns waiting worker progress for a pending run", () => {
        expect(buildProcessStepProgress({ status: "pending" }, [{ process_step: "pending" }])).toEqual({
            waiting_worker: "1/1",
        });
    });

    test("counts mixed file process steps", () => {
        expect(
            buildProcessStepProgress({ status: "started" }, [
                { process_step: "preprocessing" },
                { process_step: "metadata" },
                { process_step: "completed" },
            ])
        ).toEqual({
            preprocessing: "1/3",
            metadata: "1/3",
            completed: "1/3",
        });
    });

    test("does not report description generation after a run has completed", () => {
        expect(
            buildProcessStepProgress({ status: "completed" }, [
                { process_step: "completed" },
                { process_step: "completed" },
            ])
        ).toEqual({
            completed: "2/2",
        });
    });

    test("reports pending description generation after every file has completed in an active run", () => {
        expect(
            buildProcessStepProgress({ status: "started" }, [
                { process_step: "completed" },
                { process_step: "completed" },
            ])
        ).toEqual({
            describing: "0/2",
        });
    });

    test("reports actual description workflow progress when available", () => {
        expect(
            buildProcessStepProgress(
                { status: "started" },
                [{ process_step: "completed" }, { process_step: "completed" }],
                { done: 1, total: 3 }
            )
        ).toEqual({
            describing: "1/3",
        });
    });
});

describe("buildProcessPercentage", () => {
    test("caps completed file processing at ninety percent before descriptions", () => {
        expect(buildProcessPercentage([{ process_step: "completed" }, { process_step: "completed" }])).toBe(90);
    });

    test("uses description progress for the final ten percent", () => {
        expect(
            buildProcessPercentage([{ process_step: "completed" }, { process_step: "completed" }], {
                done: 1,
                total: 2,
            })
        ).toBe(95);
    });

    test("keeps active processing below one hundred percent until finalized", () => {
        expect(
            buildProcessPercentage([{ process_step: "completed" }], {
                done: 3,
                total: 3,
            })
        ).toBe(99);
    });
});

describe("buildDeleteStepProgress", () => {
    test("reports deleting file progress without description progress", () => {
        expect(
            buildDeleteStepProgress({
                status: "running",
                files: { done: 1, total: 2 },
                descriptions: { done: 0, total: 0 },
            })
        ).toEqual({
            process_step: {
                deleting: "1/2",
            },
            process_percentage: 50,
        });
    });

    test("reports deleting and description progress together", () => {
        expect(
            buildDeleteStepProgress({
                status: "running",
                files: { done: 2, total: 2 },
                descriptions: { done: 1, total: 3 },
            })
        ).toEqual({
            process_step: {
                deleting: "2/2",
                describing: "1/3",
            },
            process_percentage: 72,
        });
    });
});
