import type { LogAttributes, LogValue, NormalizedLogPayload } from "./types";

function normalizeScalar(value: unknown): LogValue | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (value instanceof Error) {
        return JSON.stringify({
            name: value.name,
            message: value.message,
            stack: value.stack,
        });
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function setAttribute(attributes: LogAttributes, key: string, value: unknown) {
    if (value instanceof Error) {
        attributes[`${key}.name`] = value.name;
        attributes[`${key}.message`] = value.message;
        if (value.stack) {
            attributes[`${key}.stack`] = value.stack;
        }
        return;
    }

    const normalized = normalizeScalar(value);
    if (normalized !== undefined) {
        attributes[key] = normalized;
    }
}

export function normalizeKeyvals(keyvals: unknown[]): NormalizedLogPayload {
    const attributes: LogAttributes = {};
    const pairLength = keyvals.length - (keyvals.length % 2);

    for (let index = 0; index < pairLength; index += 2) {
        const rawKey = keyvals[index];
        const rawValue = keyvals[index + 1];
        const key = String(rawKey);
        setAttribute(attributes, key, rawValue);
    }

    const invalidKeyvals = keyvals.length % 2 === 1;
    if (invalidKeyvals) {
        attributes["log.invalid_keyvals"] = true;
        const trailingValue = normalizeScalar(keyvals[keyvals.length - 1]);
        if (trailingValue !== undefined) {
            attributes["log.unpaired_value"] = trailingValue;
        }
    }

    return {
        attributes,
        invalidKeyvals,
    };
}
