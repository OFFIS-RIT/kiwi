import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type TurboConfig = {
    globalPassThroughEnv?: string[];
};

describe("turbo environment passthrough", () => {
    test("passes worker document configuration through workspace tasks", () => {
        const configPath = join(import.meta.dir, "../../../..", "turbo.json");
        const config = JSON.parse(readFileSync(configPath, "utf8")) as TurboConfig;

        expect(config.globalPassThroughEnv).toContain("DOCUMENT_MODE");
    });
});
