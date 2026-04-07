import type { GraphChunker } from "..";
import { get_encoding } from "tiktoken";

type JSONChunkerOptions = {
    maxChunkSize: number;
    encoder?: string;
};

type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export class JSONChunker implements GraphChunker {
    private readonly maxChunkSize: number;
    private readonly encoderName: string;

    constructor(options: JSONChunkerOptions) {
        this.maxChunkSize = options.maxChunkSize;
        this.encoderName = options.encoder ?? "o200k_base";
    }

    async getChunks(input: string): Promise<string[]> {
        const text = input.trim();
        if (text === "") {
            return [];
        }

        const encoder = get_encoding(this.encoderName as Parameters<typeof get_encoding>[0]);

        try {
            const tokenCount = (value: string) => encoder.encode(value).length;

            if (tokenCount(text) <= this.maxChunkSize) {
                return [text];
            }

            let raw: JSONValue;
            try {
                raw = JSON.parse(text) as JSONValue;
            } catch {
                return [text];
            }

            if (isJSONObject(raw)) {
                return this.chunkObject(raw, "$", orderedKeys(text), tokenCount);
            }

            if (Array.isArray(raw)) {
                return this.chunkArray(raw, "$", tokenCount);
            }

            return [text];
        } finally {
            encoder.free();
        }
    }

    private chunkObject(
        obj: Record<string, JSONValue>,
        path: string,
        keyOrder: string[] | undefined,
        tokenCount: (text: string) => number
    ): string[] {
        const keys = objectKeysInOrder(obj, keyOrder);
        const chunks: string[] = [];
        let currentEntries: Record<string, JSONValue> = {};
        let currentTokens = 0;

        const flush = () => {
            if (Object.keys(currentEntries).length === 0) {
                return;
            }

            let text = prettyStringify(currentEntries);
            if (path !== "$") {
                text = `Path: ${path}\n${text}`;
            }

            chunks.push(text);
            currentEntries = {};
            currentTokens = 0;
        };

        for (const key of keys) {
            if (!(key in obj)) {
                continue;
            }

            const value = obj[key]!;

            const entry: Record<string, JSONValue> = { [key]: value };
            const entryText = prettyStringify(entry);
            const entryTokens = tokenCount(entryText);

            if (entryTokens > this.maxChunkSize) {
                flush();
                chunks.push(...this.chunkValue(value, `${path}.${key}`, tokenCount));
                continue;
            }

            if (currentTokens + entryTokens > this.maxChunkSize && Object.keys(currentEntries).length > 0) {
                flush();
            }

            currentEntries[key] = value;
            currentTokens += entryTokens;
        }

        flush();
        return chunks;
    }

    private chunkArray(values: JSONValue[], path: string, tokenCount: (text: string) => number): string[] {
        const chunks: string[] = [];
        let currentValues: JSONValue[] = [];
        let currentTokens = 0;

        const flush = () => {
            if (currentValues.length === 0) {
                return;
            }

            let text = prettyStringify(currentValues);
            if (path !== "$") {
                text = `Path: ${path}\n${text}`;
            }

            chunks.push(text);
            currentValues = [];
            currentTokens = 0;
        };

        values.forEach((value, index) => {
            const entryText = prettyStringify(value);
            const entryTokens = tokenCount(entryText);

            if (entryTokens > this.maxChunkSize) {
                flush();
                chunks.push(...this.chunkValue(value, `${path}[${index}]`, tokenCount));
                return;
            }

            if (currentTokens + entryTokens > this.maxChunkSize && currentValues.length > 0) {
                flush();
            }

            currentValues.push(value);
            currentTokens += entryTokens;
        });

        flush();
        return chunks;
    }

    private chunkValue(value: JSONValue, path: string, tokenCount: (text: string) => number): string[] {
        if (isJSONObject(value)) {
            return this.chunkObject(value, path, undefined, tokenCount);
        }

        if (Array.isArray(value)) {
            return this.chunkArray(value, path, tokenCount);
        }

        return [`Path: ${path}\n${prettyStringify(value)}`];
    }
}

function isJSONObject(value: JSONValue): value is Record<string, JSONValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectKeysInOrder(obj: Record<string, JSONValue>, preferred: string[] | undefined): string[] {
    if (!preferred || preferred.length === 0) {
        return Object.keys(obj).sort();
    }

    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const key of preferred) {
        if (!(key in obj) || seen.has(key)) {
            continue;
        }

        ordered.push(key);
        seen.add(key);
    }

    if (ordered.length === Object.keys(obj).length) {
        return ordered;
    }

    const missing = Object.keys(obj)
        .filter((key) => !seen.has(key))
        .sort();

    return [...ordered, ...missing];
}

function orderedKeys(input: string): string[] | undefined {
    const trimmed = input.trim();
    if (!trimmed.startsWith("{")) {
        return undefined;
    }

    try {
        const keys: string[] = [];
        let index = 0;

        const skipWhitespace = () => {
            while (index < trimmed.length && /\s/u.test(trimmed[index]!)) {
                index += 1;
            }
        };

        const readString = (): string | undefined => {
            if (trimmed[index] !== '"') {
                return undefined;
            }

            index += 1;
            let value = "";
            let escaped = false;

            while (index < trimmed.length) {
                const char = trimmed[index];
                index += 1;

                if (escaped) {
                    value += `\\${char}`;
                    escaped = false;
                    continue;
                }

                if (char === "\\") {
                    escaped = true;
                    continue;
                }

                if (char === '"') {
                    return JSON.parse(`"${value}"`) as string;
                }

                value += char;
            }

            return undefined;
        };

        const skipValue = (): boolean => {
            skipWhitespace();
            const start = index;
            let depth = 0;
            let inString = false;
            let escaped = false;

            while (index < trimmed.length) {
                const char = trimmed[index];

                if (inString) {
                    index += 1;
                    if (escaped) {
                        escaped = false;
                    } else if (char === "\\") {
                        escaped = true;
                    } else if (char === '"') {
                        inString = false;
                    }
                    continue;
                }

                if (char === '"') {
                    inString = true;
                    index += 1;
                    continue;
                }

                if (char === "{" || char === "[") {
                    depth += 1;
                    index += 1;
                    continue;
                }

                if (char === "}" || char === "]") {
                    if (depth === 0) {
                        return index > start;
                    }
                    depth -= 1;
                    index += 1;
                    continue;
                }

                if (depth === 0 && char === ",") {
                    return index > start;
                }

                index += 1;
            }

            return index > start;
        };

        skipWhitespace();
        if (trimmed[index] !== "{") {
            return undefined;
        }
        index += 1;

        while (index < trimmed.length) {
            skipWhitespace();
            if (trimmed[index] === "}") {
                break;
            }

            const key = readString();
            if (key === undefined) {
                return undefined;
            }
            keys.push(key);

            skipWhitespace();
            if (trimmed[index] !== ":") {
                return undefined;
            }
            index += 1;

            if (!skipValue()) {
                return undefined;
            }

            skipWhitespace();
            if (trimmed[index] === ",") {
                index += 1;
            }
        }

        return keys;
    } catch {
        return undefined;
    }
}

function prettyStringify(value: JSONValue): string {
    return JSON.stringify(value, null, 2);
}
