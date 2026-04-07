import type { LoggerInstance } from "./types";

export { createConsoleLogger } from "./console";
export { normalizeKeyvals } from "./normalize";
export type { LogAttributes, LogLevel, LoggerInstance, LogValue, NormalizedLogPayload } from "./types";

export class Logger {
    constructor(private readonly instances: LoggerInstance[]) {}

    log(message: string, ...keyvals: unknown[]) {
        for (const instance of this.instances) {
            instance.log(message, ...keyvals);
        }
    }

    debug(message: string, ...keyvals: unknown[]) {
        for (const instance of this.instances) {
            instance.debug(message, ...keyvals);
        }
    }

    info(message: string, ...keyvals: unknown[]) {
        for (const instance of this.instances) {
            instance.info(message, ...keyvals);
        }
    }

    warn(message: string, ...keyvals: unknown[]) {
        for (const instance of this.instances) {
            instance.warn(message, ...keyvals);
        }
    }

    error(message: string, ...keyvals: unknown[]) {
        for (const instance of this.instances) {
            instance.error(message, ...keyvals);
        }
    }

    fatal(message: string, ...keyvals: unknown[]) {
        for (const instance of this.instances) {
            instance.fatal(message, ...keyvals);
        }
    }

    async flush() {
        for (const instance of this.instances) {
            await instance.flush?.();
        }
    }

    async shutdown() {
        for (const instance of this.instances) {
            await instance.shutdown?.();
        }
    }
}

let singleton: Logger | undefined;

export function init(...instances: LoggerInstance[]) {
    singleton = new Logger(instances);
}

export function getLogger() {
    return singleton;
}

export function log(message: string, ...keyvals: unknown[]) {
    singleton?.log(message, ...keyvals);
}

export function debug(message: string, ...keyvals: unknown[]) {
    singleton?.debug(message, ...keyvals);
}

export function info(message: string, ...keyvals: unknown[]) {
    singleton?.info(message, ...keyvals);
}

export function warn(message: string, ...keyvals: unknown[]) {
    singleton?.warn(message, ...keyvals);
}

export function error(message: string, ...keyvals: unknown[]) {
    singleton?.error(message, ...keyvals);
}

export function fatal(message: string, ...keyvals: unknown[]) {
    singleton?.fatal(message, ...keyvals);
}

export async function flush() {
    await singleton?.flush();
}

export async function shutdown() {
    await singleton?.shutdown();
}
