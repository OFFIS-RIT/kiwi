import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SCALE = 1;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const WORKER_DIR = dirname(fileURLToPath(import.meta.url));

const scale = parseScale(process.argv.slice(2));
const workers = Array.from({ length: scale }, (_, index) => startWorker(index + 1));
let shuttingDown = false;

console.log(`Starting ${String(scale)} dev worker process(es).`);

process.once("SIGINT", () => {
    void shutdown("SIGINT", 0);
});

process.once("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
});

await Promise.all(
    workers.map(async ({ process: child, slot }) => {
        const exitCode = await waitForExit(child);
        if (!shuttingDown) {
            console.warn(`Dev worker ${String(slot)} exited with code ${String(exitCode)}.`);
            await shutdown("worker-exit", exitCode ?? 1);
        }
    })
);

function startWorker(slot: number) {
    return {
        slot,
        process: spawn("bun", ["worker.ts"], {
            cwd: WORKER_DIR,
            env: {
                ...process.env,
                KIWI_WORKER_WATCH_PARENT: "1",
                KIWI_WORKER_SLOT: String(slot),
            },
            stdio: "inherit",
        }),
    };
}

async function shutdown(signal: string, exitCode: number) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log(`Shutting down dev workers (${signal})...`);

    const timeout = setTimeout(() => {
        for (const worker of workers) {
            worker.process.kill("SIGKILL");
        }
        process.exit(exitCode);
    }, SHUTDOWN_TIMEOUT_MS);

    for (const worker of workers) {
        worker.process.kill("SIGTERM");
    }

    await Promise.allSettled(workers.map((worker) => waitForExit(worker.process)));
    clearTimeout(timeout);
    process.exit(exitCode);
}

function waitForExit(child: ChildProcess): Promise<number | null> {
    const { promise, resolve } = Promise.withResolvers<number | null>();
    child.once("exit", (code) => resolve(code));
    return promise;
}

function parseScale(args: readonly string[]): number {
    const scaleFlagIndex = args.findIndex((arg) => arg === "--scale" || arg.startsWith("--scale="));
    if (scaleFlagIndex < 0) {
        return DEFAULT_SCALE;
    }

    const rawValue = args[scaleFlagIndex]?.startsWith("--scale=")
        ? args[scaleFlagIndex]?.slice("--scale=".length)
        : args[scaleFlagIndex + 1];
    const parsed = Number.parseInt(rawValue ?? "", 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--scale must be a positive integer");
    }
    return parsed;
}
