import { describe, expect, test } from "bun:test";
import { TOMLChunker } from "../toml.ts";

describe("TOMLChunker", () => {
    test("returns no chunks for empty input", async () => {
        const chunks = await new TOMLChunker({ maxChunkSize: 100 }).getChunks("");

        expect(chunks).toEqual([]);
    });

    test("returns small TOML as a single chunk", async () => {
        const input = '[server]\nhost = "example.test"\nport = 443';
        const chunks = await new TOMLChunker({ maxChunkSize: 100 }).getChunks(input);

        expect(chunks).toEqual([input]);
    });

    test("splits tables without dropping table headers", async () => {
        const input = [
            "[server]",
            `description = "${"alpha ".repeat(80)}"`,
            "[database]",
            `description = "${"beta ".repeat(80)}"`,
        ].join("\n");
        const chunks = await new TOMLChunker({ maxChunkSize: 30 }).getChunks(input);
        const joined = chunks.join("\n");

        expect(chunks.length).toBeGreaterThan(1);
        expect(joined).toContain("[server]");
        expect(joined).toContain("[database]");
    });

    test("repeats table context for oversized table entries", async () => {
        const input = ["[server]", `description = "${"alpha ".repeat(100)}"`, "port = 443"].join("\n");
        const chunks = await new TOMLChunker({ maxChunkSize: 24 }).getChunks(input);
        const joined = chunks.join("\n");

        expect(chunks.length).toBeGreaterThan(1);
        expect(joined).toContain("Path: $.server");
        expect(chunks.every((chunk) => chunk.includes("[server]"))).toBe(true);
    });

    test("keeps array-table and quoted header context", async () => {
        const input = [
            '[[servers."primary.node"]]',
            'host = "api.example.test"',
            `description = "${"alpha ".repeat(100)}"`,
            "[database]",
            `description = "${"beta ".repeat(100)}"`,
        ].join("\n");
        const chunks = await new TOMLChunker({ maxChunkSize: 24 }).getChunks(input);
        const joined = chunks.join("\n");

        expect(chunks.length).toBeGreaterThan(1);
        expect(joined).toContain('[[servers."primary.node"]]');
        expect(joined).toContain('Path: $.servers["primary.node"][]');
        expect(joined).toContain("Path: $.database");
    });
});
