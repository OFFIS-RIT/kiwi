export type LogLevel = "log" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, unknown>;

export type LogAttributes = Record<string, LogValue>;

export type NormalizedLogPayload = {
    attributes: LogAttributes;
};

export interface LoggerInstance {
    log(message: string, fields?: LogFields): void;
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
    fatal(message: string, fields?: LogFields): void;
    flush?(): Promise<void>;
    shutdown?(): Promise<void>;
}
