import { backend } from "./";
import { defineConfig } from "@openworkflow/cli";

export default defineConfig({
    backend,
    dirs: "./workflows",
    ignorePatterns: ["**/*.run.*"],
});
