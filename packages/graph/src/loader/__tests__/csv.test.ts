import { describe, expect, test } from "bun:test";

import { CSVLoader } from "../csv";

describe("CSVLoader", () => {
    test("decodes CSV text without parsing rows", async () => {
        const text = 'id,note\n1,"unterminated';
        const loader = new CSVLoader({
            loader: {
                getBinary: async () => new TextEncoder().encode(text).buffer,
                getText: async () => text,
            },
        });

        await expect(loader.getText()).resolves.toBe(text);
    });
});
