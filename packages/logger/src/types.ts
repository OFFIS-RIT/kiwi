import type * as Effect from "effect/Effect";

export type LogLevel = "log" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, unknown>;

export type LogAttributes = Record<string, LogValue>;

export type NormalizedLogPayload = {
    attributes: LogAttributes;
};

export class LoggerError extends Error {
    readonly _tag = "LoggerError";

    constructor(operation: string, options?: { cause?: unknown }) {
        super(`Logger operation failed: ${operation}`, options);
        this.name = "LoggerError";
    }
}

export interface LoggerInstance {
    log(message: string, fields?: LogFields): void;
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
    fatal(message: string, fields?: LogFields): void;
    flush?(): Effect.Effect<void, LoggerError>;
    shutdown?(): Effect.Effect<void, LoggerError>;
}
