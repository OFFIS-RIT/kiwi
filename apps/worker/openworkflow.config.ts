import { defineConfig } from "@openworkflow/cli";
import { env } from "./env";
import { backend } from ".";

export default defineConfig({
    backend,
    dirs: "./workflows",
    ignorePatterns: ["**/*.run.*"],
    worker: {
        concurrency: env.WORKER_CONCURRENCY,
    },
});
