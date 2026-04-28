import cluster from "node:cluster";
import { availableParallelism } from "node:os";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const WATCH_PARENT_PROCESS = process.env.KIWI_WORKER_WATCH_PARENT === "1";
const WORKER_CONCURRENCY_ENV = "KIWI_WORKER_CONCURRENCY_SLOT";

if (!WATCH_PARENT_PROCESS && cluster.isPrimary) {
    startClusterPrimary();
} else {
    await startWorkerProcess();
}

function startClusterPrimary() {
    let shuttingDown = false;
    const totalConcurrency = readPositiveInteger(process.env.WORKER_CONCURRENCY, 1);
    const processCount = Math.min(availableParallelism(), totalConcurrency);
    const concurrencySlots = splitConcurrency(totalConcurrency, processCount);
    const concurrencyByWorkerId = new Map<number, number>();

    console.log(
        `Starting worker cluster with ${String(processCount)} process(es), total concurrency ${String(totalConcurrency)}`
    );

    for (const concurrency of concurrencySlots) {
        forkWorker(concurrency);
    }

    cluster.on("exit", (worker, code, signal) => {
        console.warn("Worker process exited", {
            pid: worker.process.pid,
            code,
            signal,
        });

        if (shuttingDown) {
            return;
        }

        const replacementConcurrency = concurrencyByWorkerId.get(worker.id) ?? 1;
        concurrencyByWorkerId.delete(worker.id);
        setTimeout(() => {
            forkWorker(replacementConcurrency);
        }, 1000);
    });

    process.once("SIGINT", () => {
        void shutdownCluster("SIGINT");
    });

    process.once("SIGTERM", () => {
        void shutdownCluster("SIGTERM");
    });

    async function shutdownCluster(signal: NodeJS.Signals) {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        console.log(`Shutting down worker cluster (${signal})...`);

        const workers = Object.values(cluster.workers ?? {}).filter(
            (worker): worker is NonNullable<typeof worker> => worker !== undefined
        );
        const workerExits = workers.map(
            (worker) =>
                new Promise<void>((resolve) => {
                    if (worker.isDead()) {
                        resolve();
                        return;
                    }

                    worker.once("exit", () => {
                        resolve();
                    });
                })
        );

        for (const worker of workers) {
            worker.kill(signal);
        }

        const forceKillTimeout = setTimeout(() => {
            for (const worker of workers) {
                if (!worker.isDead()) {
                    worker.kill("SIGKILL");
                }
            }
        }, SHUTDOWN_TIMEOUT_MS);

        await Promise.allSettled(workerExits);
        clearTimeout(forceKillTimeout);
        console.log("Worker cluster stopped");
        process.exit(0);
    }

    function forkWorker(concurrency: number) {
        const worker = cluster.fork({ [WORKER_CONCURRENCY_ENV]: String(concurrency) });
        concurrencyByWorkerId.set(worker.id, concurrency);
    }
}

async function startWorkerProcess() {
    const [
        { backend, ow },
        { env },
        { deleteProjectFile },
        { deleteGraphFiles },
        { processFile, processFiles },
        { updateDescriptions },
    ] = await Promise.all([
        import("."),
        import("./env"),
        import("./workflows/delete-file"),
        import("./workflows/delete-graph-files"),
        import("./workflows/process-file"),
        import("./workflows/update-descriptions"),
    ]);

    const parentPid = process.ppid;
    const concurrency = readPositiveInteger(process.env[WORKER_CONCURRENCY_ENV], env.WORKER_CONCURRENCY);

    ow.implementWorkflow(processFiles.spec, processFiles.fn);
    ow.implementWorkflow(processFile.spec, processFile.fn);
    ow.implementWorkflow(deleteProjectFile.spec, deleteProjectFile.fn);
    ow.implementWorkflow(deleteGraphFiles.spec, deleteGraphFiles.fn);
    ow.implementWorkflow(updateDescriptions.spec, updateDescriptions.fn);

    const worker = ow.newWorker({ concurrency });
    let shuttingDown = false;

    async function shutdown(signal: string, exitCode = 0) {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        console.log(`Shutting down worker process (${signal})...`);

        const timeout = setTimeout(() => {
            console.warn("Worker process shutdown timed out");
            process.exit(exitCode);
        }, SHUTDOWN_TIMEOUT_MS);

        try {
            try {
                await worker.stop();
            } finally {
                await backend.stop();
            }
        } finally {
            clearTimeout(timeout);
        }

        console.log("Worker process stopped");
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
    console.log(`Worker process started with concurrency ${String(concurrency)}.`);
}

function readPositiveInteger(value: string | undefined, fallback: number) {
    if (value === undefined) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }

    return parsed;
}

function splitConcurrency(total: number, processes: number) {
    const base = Math.floor(total / processes);
    const extra = total % processes;

    return Array.from({ length: processes }, (_, index) => base + (index < extra ? 1 : 0));
}
