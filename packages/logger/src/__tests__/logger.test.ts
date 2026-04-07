import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Logger, debug, error, fatal, flush, getLogger, info, init, log, shutdown, warn } from "../index";
import type { LoggerInstance } from "../types";

function createMockInstance() {
    return {
        log: mock(),
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
        fatal: mock(),
        flush: mock(async () => undefined),
        shutdown: mock(async () => undefined),
    } satisfies LoggerInstance;
}

describe("logger singleton", () => {
    beforeEach(() => {
        init();
    });

    test("top-level functions are safe before init consumers are installed", async () => {
        log("message");
        debug("message");
        info("message");
        warn("message");
        error("message");
        fatal("message");
        await flush();
        await shutdown();
    });

    test("dispatches to all instances", () => {
        const left = createMockInstance();
        const right = createMockInstance();

        init(left, right);
        info("started", "port", 4321);

        expect(left.info).toHaveBeenCalledWith("started", "port", 4321);
        expect(right.info).toHaveBeenCalledWith("started", "port", 4321);
    });

    test("re-init replaces existing instances", () => {
        const stale = createMockInstance();
        const current = createMockInstance();

        init(stale);
        init(current);
        warn("swapped");

        expect(stale.warn).not.toHaveBeenCalled();
        expect(current.warn).toHaveBeenCalledWith("swapped");
    });

    test("flush and shutdown call backend lifecycle hooks", async () => {
        const instance = createMockInstance();

        init(instance);
        await flush();
        await shutdown();

        expect(instance.flush).toHaveBeenCalledTimes(1);
        expect(instance.shutdown).toHaveBeenCalledTimes(1);
    });

    test("getLogger returns current singleton", () => {
        const instance = createMockInstance();

        init(instance);

        expect(getLogger()).toBeInstanceOf(Logger);
    });
});
