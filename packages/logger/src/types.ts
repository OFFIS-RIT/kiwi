export type LogLevel = "log" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogValue = string | number | boolean | null;

export type LogAttributes = Record<string, LogValue>;

export type NormalizedLogPayload = {
    attributes: LogAttributes;
    invalidKeyvals: boolean;
};

export interface LoggerInstance {
    log(message: string, ...keyvals: unknown[]): void;
    debug(message: string, ...keyvals: unknown[]): void;
    info(message: string, ...keyvals: unknown[]): void;
    warn(message: string, ...keyvals: unknown[]): void;
    error(message: string, ...keyvals: unknown[]): void;
    fatal(message: string, ...keyvals: unknown[]): void;
    flush?(): Promise<void>;
    shutdown?(): Promise<void>;
}
