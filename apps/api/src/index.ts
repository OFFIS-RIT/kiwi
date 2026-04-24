import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { info } from "@kiwi/logger";
import { initLogger, shutdownLogger } from "./logger";

initLogger();

let isShuttingDown = false;

if (cluster.isPrimary) {
    for (let i = 0; i < availableParallelism(); i++) {
        cluster.fork();
    }

    cluster.on("exit", (worker, code, signal) => {
        info("api worker exited", {
            pid: worker.process.pid,
            code,
            signal,
        });

        if (!isShuttingDown) {
            setTimeout(() => {
                cluster.fork();
            }, 1000);
        }
    });

    process.once("SIGINT", () => {
        void handlePrimaryShutdown("SIGINT");
    });

    process.once("SIGTERM", () => {
        void handlePrimaryShutdown("SIGTERM");
    });
} else {
    await import("./server");
}

async function handlePrimaryShutdown(signal: NodeJS.Signals) {
    isShuttingDown = true;
    info("api primary shutting down", { signal, pid: process.pid });

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
    }, 25_000);

    await Promise.allSettled(workerExits);

    clearTimeout(forceKillTimeout);
    await shutdownLogger();
    process.exit(0);
}
