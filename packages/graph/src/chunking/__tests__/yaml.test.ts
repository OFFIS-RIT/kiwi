import { describe, expect, test } from "bun:test";
import { YAMLChunker } from "../yaml.ts";

describe("YAMLChunker", () => {
    test("returns no chunks for empty input", async () => {
        const chunks = await new YAMLChunker({ maxChunkSize: 100 }).getChunks("");

        expect(chunks).toEqual([]);
    });

    test("returns small YAML as a single chunk", async () => {
        const input = "server:\n  host: example.test\n  port: 443";
        const chunks = await new YAMLChunker({ maxChunkSize: 100 }).getChunks(input);

        expect(chunks).toEqual([input]);
    });

    test("splits top-level sections without dropping section keys", async () => {
        const input = [
            "# deployment settings",
            "server:",
            `  description: ${"alpha ".repeat(80)}`,
            "database:",
            `  description: ${"beta ".repeat(80)}`,
        ].join("\n");
        const chunks = await new YAMLChunker({ maxChunkSize: 30 }).getChunks(input);
        const joined = chunks.join("\n");

        expect(chunks.length).toBeGreaterThan(1);
        expect(joined).toContain("# deployment settings");
        expect(joined).toContain("server:");
        expect(joined).toContain("database:");
    });

    test("adds path and ancestor context for oversized nested sections", async () => {
        const input = ["root:", "  child:", `    description: ${"alpha ".repeat(100)}`].join("\n");
        const chunks = await new YAMLChunker({ maxChunkSize: 24 }).getChunks(input);
        const joined = chunks.join("\n");

        expect(chunks.length).toBeGreaterThan(1);
        expect(joined).toContain("Path: $.root.child");
        expect(joined).toContain("Context:");
        expect(joined).toContain("root:");
    });

    test("keeps comments and list item context for oversized arrays", async () => {
        const input = [
            "services:",
            "  # primary service",
            "  - name: api",
            `    description: ${"alpha ".repeat(100)}`,
            "  - name: worker",
            `    description: ${"beta ".repeat(100)}`,
        ].join("\n");
        const chunks = await new YAMLChunker({ maxChunkSize: 24 }).getChunks(input);
        const joined = chunks.join("\n");

        expect(chunks.length).toBeGreaterThan(1);
        expect(joined).toContain("# primary service");
        expect(joined).toContain("Path: $.services[");
        expect(joined).toContain("name: api");
        expect(joined).toContain("name: worker");
    });
});
