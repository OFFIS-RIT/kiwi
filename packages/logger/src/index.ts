import * as Effect from "effect/Effect";
import type { LogFields, LoggerError, LoggerInstance } from "./types";

export { createConsoleLogger } from "./console";
export { shapeFields } from "./normalize";
export type {
    LogAttributes,
    LogFields,
    LogLevel,
    LoggerError,
    LoggerInstance,
    LogValue,
    NormalizedLogPayload,
} from "./types";

const flushLoggerInstances = Effect.fn("Logger.flush")(function* (instances: readonly LoggerInstance[]) {
    for (const instance of instances) {
        const flush = instance.flush;
        if (flush) {
            yield* flush.call(instance);
        }
    }
});

const shutdownLoggerInstances = Effect.fn("Logger.shutdown")(function* (instances: readonly LoggerInstance[]) {
    for (const instance of instances) {
        const shutdown = instance.shutdown;
        if (shutdown) {
            yield* shutdown.call(instance);
        }
    }
});

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

    flush(): Effect.Effect<void, LoggerError> {
        return flushLoggerInstances(this.instances);
    }

    shutdown(): Effect.Effect<void, LoggerError> {
        return shutdownLoggerInstances(this.instances);
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

export const flush: () => Effect.Effect<void, LoggerError> = Effect.fn("logger.flush")(function* () {
    if (singleton) {
        yield* singleton.flush();
    }
});

export const shutdown: () => Effect.Effect<void, LoggerError> = Effect.fn("logger.shutdown")(function* () {
    if (singleton) {
        yield* singleton.shutdown();
    }
});
