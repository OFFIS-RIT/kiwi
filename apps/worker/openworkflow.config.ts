import { backend } from "./";
import { defineConfig } from "@openworkflow/cli";
import { env } from "./env";

export default defineConfig({
    backend,
    dirs: "./workflows",
    ignorePatterns: ["**/*.run.*"],
    worker: {
        concurrency: env.WORKER_CONCURRENCY ? env.WORKER_CONCURRENCY : 1,
    },
});
