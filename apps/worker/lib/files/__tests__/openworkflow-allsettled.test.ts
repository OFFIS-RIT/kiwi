import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendSqlite } from "openworkflow/sqlite";
import { OpenWorkflow, defineWorkflow } from "openworkflow";

describe("patched OpenWorkflow child workflow fan-out", () => {
    test("parks a parent when Promise.allSettled observes child workflow sleep signals", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "kiwi-openworkflow-"));
        const backend = BackendSqlite.connect(join(tempDir, "workflow.sqlite"));

        try {
            const ow = new OpenWorkflow({ backend });
            const child = defineWorkflow(
                {
                    name: "allsettled-child",
                    retryPolicy: { maximumAttempts: 1 },
                },
                async ({ step }) => {
                    await step.sleep("wait", "1h");
                }
            );
            const parent = defineWorkflow(
                {
                    name: "allsettled-parent",
                    retryPolicy: { maximumAttempts: 1 },
                },
                async ({ step }) => {
                    const results = await Promise.allSettled([
                        step.runWorkflow(child.spec),
                        step.runWorkflow(child.spec),
                    ]);
                    const failures = results.filter((result) => result.status === "rejected");

                    if (failures.length > 0) {
                        throw new Error(`${failures.length} child workflows failed`);
                    }
                }
            );

            ow.implementWorkflow(child.spec, child.fn);
            ow.implementWorkflow(parent.spec, parent.fn);

            const handle = await ow.runWorkflow(parent.spec);
            const worker = ow.newWorker({ concurrency: 1 });
            await worker.tick();
            await worker.stop();

            const parentRun = await backend.getWorkflowRun({ workflowRunId: handle.workflowRun.id });
            expect(parentRun?.status).toBe("running");
            expect(parentRun?.error).toBeNull();

            const parentSteps = await backend.listStepAttempts({ workflowRunId: handle.workflowRun.id });
            expect(parentSteps.data).toHaveLength(2);
            expect(parentSteps.data.every((stepAttempt) => stepAttempt.status === "running")).toBe(true);
        } finally {
            await backend.stop();
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
