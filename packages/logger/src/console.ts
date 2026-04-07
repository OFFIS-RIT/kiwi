import { normalizeKeyvals } from "./normalize";
import type { LogLevel, LoggerInstance } from "./types";

export type ConsoleLoggerOptions = {
    level?: LogLevel;
    timestamps?: boolean;
    console?: Pick<Console, "log" | "debug" | "info" | "warn" | "error">;
};

const levelPriority: Record<LogLevel, number> = {
    debug: 10,
    log: 20,
    info: 20,
    warn: 30,
    error: 40,
    fatal: 50,
};

function shouldLog(messageLevel: LogLevel, configuredLevel: LogLevel) {
    return levelPriority[messageLevel] >= levelPriority[configuredLevel];
}

function formatLine(level: LogLevel, message: string, timestamps: boolean) {
    const parts = [];
    if (timestamps) {
        parts.push(`[${new Date().toISOString()}]`);
    }
    parts.push(level.toUpperCase(), message);
    return parts.join(" ");
}

class ConsoleLogger implements LoggerInstance {
    private readonly level: LogLevel;
    private readonly timestamps: boolean;
    private readonly console: Pick<Console, "log" | "debug" | "info" | "warn" | "error">;

    constructor(options: ConsoleLoggerOptions = {}) {
        this.level = options.level ?? "info";
        this.timestamps = options.timestamps ?? true;
        this.console = options.console ?? console;
    }

    private write(level: LogLevel, message: string, keyvals: unknown[]) {
        if (!shouldLog(level, this.level)) {
            return;
        }

        const { attributes } = normalizeKeyvals(keyvals);
        const line = formatLine(level, message, this.timestamps);
        const hasAttributes = Object.keys(attributes).length > 0;
        const method = this.getMethod(level);

        if (hasAttributes) {
            method.call(this.console, line, attributes);
            return;
        }

        method.call(this.console, line);
    }

    private getMethod(level: LogLevel) {
        switch (level) {
            case "debug":
                return this.console.debug;
            case "warn":
                return this.console.warn;
            case "error":
            case "fatal":
                return this.console.error;
            case "info":
                return this.console.info;
            case "log":
            default:
                return this.console.log;
        }
    }

    log(message: string, ...keyvals: unknown[]) {
        this.write("log", message, keyvals);
    }

    debug(message: string, ...keyvals: unknown[]) {
        this.write("debug", message, keyvals);
    }

    info(message: string, ...keyvals: unknown[]) {
        this.write("info", message, keyvals);
    }

    warn(message: string, ...keyvals: unknown[]) {
        this.write("warn", message, keyvals);
    }

    error(message: string, ...keyvals: unknown[]) {
        this.write("error", message, keyvals);
    }

    fatal(message: string, ...keyvals: unknown[]) {
        this.write("fatal", message, keyvals);
    }
}

export function createConsoleLogger(options: ConsoleLoggerOptions = {}): LoggerInstance {
    return new ConsoleLogger(options);
}
