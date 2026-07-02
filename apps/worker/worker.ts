import * as Effect from "effect/Effect";
import { info as logInfo, warn as logWarn } from "@kiwi/logger";
import { initLogger, shutdownLogger } from "./logger";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const WATCH_PARENT_PROCESS = process.env.KIWI_WORKER_WATCH_PARENT === "1";

await startWorkerProcess();

async function startWorkerProcess() {
    initLogger();

    const [
        { wo },
        { deleteProjectFile },
        { deleteGraphFiles },
        { processFile, processFiles },
        { processCodeFile },
        { updateDescriptions },
        { syncConnectorResourceGraph },
        { processDescriptionsGroups },
    ] = await Promise.all([
        import("."),
        import("./workflows/delete-file"),
        import("./workflows/delete-graph-files"),
        import("./workflows/process-file"),
        import("./workflows/process-code-file"),
        import("./workflows/update-descriptions"),
        import("./workflows/sync-connector-resource-graph"),
        import("./workflows/process-descriptions-group"),
    ]);

    const parentPid = process.ppid;

    wo.implementWorkflow(processFiles.spec, processFiles.fn);
    wo.implementWorkflow(processFile.spec, processFile.fn);
    wo.implementWorkflow(processCodeFile.spec, processCodeFile.fn);
    wo.implementWorkflow(deleteProjectFile.spec, deleteProjectFile.fn);
    wo.implementWorkflow(deleteGraphFiles.spec, deleteGraphFiles.fn);
    wo.implementWorkflow(updateDescriptions.spec, updateDescriptions.fn);
    wo.implementWorkflow(syncConnectorResourceGraph.spec, syncConnectorResourceGraph.fn);
    wo.implementWorkflow(processDescriptionsGroups.spec, processDescriptionsGroups.fn);

    const worker = wo.newWorker();
    let shuttingDown = false;

    async function shutdown(signal: string, exitCode = 0) {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        logInfo("shutting down worker", { signal });

        const timeout = setTimeout(() => {
            logWarn("worker shutdown timed out", { signal });
            void Effect.runPromise(shutdownLogger()).finally(() => process.exit(exitCode));
        }, SHUTDOWN_TIMEOUT_MS);

        try {
            await worker.stop();
        } finally {
            clearTimeout(timeout);
            await Effect.runPromise(shutdownLogger());
        }

        logInfo("worker stopped", { signal });
        process.exit(exitCode);
    }

    process.once("SIGINT", () => {
        void shutdown("SIGINT");
    });

    process.once("SIGTERM", () => {
        void shutdown("SIGTERM");
    });

    if (WATCH_PARENT_PROCESS) {
        setInterval(() => {
            if (process.ppid !== parentPid) {
                void shutdown("parent-exit");
                return;
            }

            try {
                process.kill(parentPid, 0);
            } catch {
                void shutdown("parent-exit");
            }
        }, 1000);
    }

    await worker.start();
    logInfo("worker started");
}
