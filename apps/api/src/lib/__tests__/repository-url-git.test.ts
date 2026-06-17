import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";

const MAX_GIT_OUTPUT_BYTES = 1 * 1024 * 1024;
let scenario: "broken-symlink" | "limit" | "symlink" = "limit";
let spawnCall = 0;

mock.module("node:child_process", () => ({
    spawn: () => {
        spawnCall += 1;
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: () => undefined,
        });

        queueMicrotask(() => {
            if (spawnCall === 2) {
                child.stdout.emit("data", Buffer.from("commit-sha\n"));
            }
            if (spawnCall === 3) {
                child.stdout.emit(
                    "data",
                    Buffer.from(
                        scenario === "symlink" || scenario === "broken-symlink"
                            ? "config.ts\0src/index.ts\0"
                            : Buffer.alloc(MAX_GIT_OUTPUT_BYTES + 1)
                    )
                );
            }
            child.emit("close", spawnCall === 3 && scenario === "limit" ? null : 0);
        });

        return child;
    },
}));

mock.module("node:fs/promises", () => ({
    mkdtemp: async () => "/tmp/kiwi-repository-test",
    readFile: async (filePath: string) => {
        if (filePath.endsWith("config.ts")) {
            return "server-secret";
        }
        return "export const safe = true;\n";
    },
    realpath: async (filePath: string) => {
        if (scenario === "broken-symlink" && filePath.endsWith("config.ts")) {
            throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        }
        if (filePath.endsWith("config.ts")) {
            return "/etc/passwd";
        }
        return filePath;
    },
    rm: async () => undefined,
    stat: async (filePath: string) => ({
        isFile: () => true,
        size: filePath.endsWith("config.ts") ? "server-secret".length : "export const safe = true;\n".length,
    }),
}));

// Dynamic import is required so Bun module mocks replace child_process before evaluation.
const { loadRepositoryFromUrl } = await import("../repository-url");

describe("repository URL git loading", () => {
    beforeEach(() => {
        spawnCall = 0;
        scenario = "limit";
    });

    test("rejects truncated git stdout as a repository limit", async () => {
        await expect(Effect.runPromise(loadRepositoryFromUrl("https://github.com/acme/app"))).rejects.toMatchObject({
            name: "RepositoryUrlError",
            kind: "limit",
        });
    });

    test("skips repository files whose real path escapes the clone root", async () => {
        scenario = "symlink";

        await expect(Effect.runPromise(loadRepositoryFromUrl("https://github.com/acme/app"))).resolves.toMatchObject({
            files: [
                {
                    path: "src/index.ts",
                    content: "export const safe = true;\n",
                },
            ],
        });
    });

    test("skips repository files whose real path cannot be resolved", async () => {
        scenario = "broken-symlink";

        await expect(Effect.runPromise(loadRepositoryFromUrl("https://github.com/acme/app"))).resolves.toMatchObject({
            files: [
                {
                    path: "src/index.ts",
                    content: "export const safe = true;\n",
                },
            ],
        });
    });
});
