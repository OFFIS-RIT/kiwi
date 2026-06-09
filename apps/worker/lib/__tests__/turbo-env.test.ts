import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type TurboConfig = {
    globalPassThroughEnv?: string[];
};

describe("turbo environment passthrough", () => {
    test("passes worker document and AI concurrency configuration through workspace tasks", () => {
        const configPath = join(import.meta.dir, "../../../..", "turbo.json");
        const config = JSON.parse(readFileSync(configPath, "utf8")) as TurboConfig;

        expect(config.globalPassThroughEnv).toContain("DOCUMENT_MODE");
        expect(config.globalPassThroughEnv).toContain("AUTH_SECRET");
        expect(config.globalPassThroughEnv).toContain("AI_TEXT_CONCURRENCY");
        expect(config.globalPassThroughEnv).toContain("AI_IMAGE_CONCURRENCY");
        expect(config.globalPassThroughEnv).toContain("AI_EMBEDDING_CONCURRENCY");
        expect(config.globalPassThroughEnv).toContain("AI_AUDIO_CONCURRENCY");
        expect(config.globalPassThroughEnv).toContain("AI_VIDEO_CONCURRENCY");
        expect(config.globalPassThroughEnv).toContain("AI_TEXT_KEY");
        expect(config.globalPassThroughEnv).toContain("AI_EXTRACT_KEY");
        expect(config.globalPassThroughEnv).toContain("AI_EMBEDDING_KEY");
        expect(config.globalPassThroughEnv).toContain("AI_AUDIO_KEY");
        expect(config.globalPassThroughEnv).toContain("AI_VIDEO_KEY");
    });

    test("production compose provides usable AI concurrency defaults and worker auth secret", () => {
        const composePath = join(import.meta.dir, "../../../..", "compose.prod.yml");
        const compose = readFileSync(composePath, "utf8");

        expect(compose).toContain("AUTH_SECRET: ${AUTH_SECRET}");
        expect(compose).toContain("AI_TEXT_CONCURRENCY: ${AI_TEXT_CONCURRENCY:-64}");
        expect(compose).toContain("AI_IMAGE_CONCURRENCY: ${AI_IMAGE_CONCURRENCY:-64}");
        expect(compose).toContain("AI_EMBEDDING_CONCURRENCY: ${AI_EMBEDDING_CONCURRENCY:-64}");
        expect(compose).toContain("AI_AUDIO_CONCURRENCY: ${AI_AUDIO_CONCURRENCY:-64}");
        expect(compose).toContain("AI_VIDEO_CONCURRENCY: ${AI_VIDEO_CONCURRENCY:-64}");
        expect(compose).toContain("AI_TEXT_KEY: ${AI_TEXT_KEY:-}");
        expect(compose).toContain("AI_EXTRACT_KEY: ${AI_EXTRACT_KEY:-}");
        expect(compose).toContain("AI_EMBEDDING_KEY: ${AI_EMBEDDING_KEY:-}");
        expect(compose).toContain("AI_AUDIO_KEY: ${AI_AUDIO_KEY:-}");
        expect(compose).toContain("AI_VIDEO_KEY: ${AI_VIDEO_KEY:-}");
    });
});
