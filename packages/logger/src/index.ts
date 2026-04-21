import type { LogFields, LoggerInstance } from "./types";

export { createConsoleLogger } from "./console";
export { shapeFields } from "./normalize";
export type { LogAttributes, LogFields, LogLevel, LoggerInstance, LogValue, NormalizedLogPayload } from "./types";

export class Logger {
    constructor(private readonly instances: LoggerInstance[]) {}

    log(message: string, fields?: LogFields) {
        for (const instance of this.instances) {
            if (fields === undefined) {
                instance.log(message);
                continue;
            }

            instance.log(message, fields);
        }
    }

    debug(message: string, fields?: LogFields) {
        for (const instance of this.instances) {
            if (fields === undefined) {
                instance.debug(message);
                continue;
            }

            instance.debug(message, fields);
        }
    }

    info(message: string, fields?: LogFields) {
        for (const instance of this.instances) {
            if (fields === undefined) {
                instance.info(message);
                continue;
            }

            instance.info(message, fields);
        }
    }

    warn(message: string, fields?: LogFields) {
        for (const instance of this.instances) {
            if (fields === undefined) {
                instance.warn(message);
                continue;
            }

            instance.warn(message, fields);
        }
    }

    error(message: string, fields?: LogFields) {
        for (const instance of this.instances) {
            if (fields === undefined) {
                instance.error(message);
                continue;
            }

            instance.error(message, fields);
        }
    }

    fatal(message: string, fields?: LogFields) {
        for (const instance of this.instances) {
            if (fields === undefined) {
                instance.fatal(message);
                continue;
            }

            instance.fatal(message, fields);
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

export function log(message: string, fields?: LogFields) {
    singleton?.log(message, fields);
}

export function debug(message: string, fields?: LogFields) {
    singleton?.debug(message, fields);
}

export function info(message: string, fields?: LogFields) {
    singleton?.info(message, fields);
}

export function warn(message: string, fields?: LogFields) {
    singleton?.warn(message, fields);
}

export function error(message: string, fields?: LogFields) {
    singleton?.error(message, fields);
}

export function fatal(message: string, fields?: LogFields) {
    singleton?.fatal(message, fields);
}

export async function flush() {
    await singleton?.flush();
}

export async function shutdown() {
    await singleton?.shutdown();
}
