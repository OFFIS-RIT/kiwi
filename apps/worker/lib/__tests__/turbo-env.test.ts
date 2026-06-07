import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type TurboConfig = {
    globalPassThroughEnv?: string[];
};

describe("turbo environment passthrough", () => {
    test("passes worker document and media configuration through workspace tasks", () => {
        const configPath = join(import.meta.dir, "../../../..", "turbo.json");
        const config = JSON.parse(readFileSync(configPath, "utf8")) as TurboConfig;

        expect(config.globalPassThroughEnv).toContain("DOCUMENT_MODE");
        expect(config.globalPassThroughEnv).toContain("AI_AUDIO_CONCURRENCY");
        expect(config.globalPassThroughEnv).toContain("AI_AUDIO_ADAPTER");
        expect(config.globalPassThroughEnv).toContain("AI_AUDIO_MODEL");
        expect(config.globalPassThroughEnv).toContain("AI_AUDIO_KEY");
        expect(config.globalPassThroughEnv).toContain("AI_AUDIO_URL");
        expect(config.globalPassThroughEnv).toContain("AI_AUDIO_RESOURCE_NAME");
        expect(config.globalPassThroughEnv).toContain("AI_VIDEO_CONCURRENCY");
        expect(config.globalPassThroughEnv).toContain("AI_VIDEO_ADAPTER");
        expect(config.globalPassThroughEnv).toContain("AI_VIDEO_MODEL");
        expect(config.globalPassThroughEnv).toContain("AI_VIDEO_KEY");
        expect(config.globalPassThroughEnv).toContain("AI_VIDEO_URL");
        expect(config.globalPassThroughEnv).toContain("AI_VIDEO_RESOURCE_NAME");
    });

    test("production compose provides usable AI concurrency defaults", () => {
        const composePath = join(import.meta.dir, "../../../..", "compose.prod.yml");
        const compose = readFileSync(composePath, "utf8");

        expect(compose).toContain("AI_TEXT_CONCURRENCY: ${AI_TEXT_CONCURRENCY:-64}");
        expect(compose).toContain("AI_IMAGE_CONCURRENCY: ${AI_IMAGE_CONCURRENCY:-64}");
        expect(compose).toContain("AI_EMBEDDING_CONCURRENCY: ${AI_EMBEDDING_CONCURRENCY:-64}");
        expect(compose).toContain("AI_AUDIO_CONCURRENCY: ${AI_AUDIO_CONCURRENCY:-64}");
        expect(compose).toContain("AI_VIDEO_CONCURRENCY: ${AI_VIDEO_CONCURRENCY:-64}");
    });
});
