import { describe, expect, test } from "bun:test";
import { buildProcessStepProgress } from "./process-progress";

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

    test("reports description generation after every file has completed in an active run", () => {
        expect(
            buildProcessStepProgress({ status: "started" }, [
                { process_step: "completed" },
                { process_step: "completed" },
            ])
        ).toEqual({
            describing: "2/2",
            completed: "2/2",
        });
    });
});
