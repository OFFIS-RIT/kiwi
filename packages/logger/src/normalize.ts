import type { LogAttributes, LogFields, LogValue, NormalizedLogPayload } from "./types";

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

export function normalizeFields(fields?: LogFields): NormalizedLogPayload {
    const attributes: LogAttributes = {};

    if (!fields) {
        return {
            attributes,
        };
    }

    for (const [key, value] of Object.entries(fields)) {
        setAttribute(attributes, key, value);
    }

    return {
        attributes,
    };
}
