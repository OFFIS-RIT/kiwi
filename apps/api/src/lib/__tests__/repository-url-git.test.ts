import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const MAX_GIT_OUTPUT_BYTES = 1 * 1024 * 1024;
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
                child.stdout.emit("data", Buffer.alloc(MAX_GIT_OUTPUT_BYTES + 1));
            }
            child.emit("close", spawnCall === 3 ? null : 0);
        });

        return child;
    },
}));

// Dynamic import is required so Bun module mocks replace child_process before evaluation.
const { loadRepositoryFromUrl } = await import("../repository-url");

describe("repository URL git loading", () => {
    beforeEach(() => {
        spawnCall = 0;
    });

    test("rejects truncated git stdout as a repository limit", async () => {
        await expect(loadRepositoryFromUrl("https://github.com/acme/app")).rejects.toMatchObject({
            name: "RepositoryUrlError",
            kind: "limit",
        });
    });
});
