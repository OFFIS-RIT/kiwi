import { describe, expect, mock, test } from "bun:test";
import { createConsoleLogger } from "../console";

function createConsoleMock() {
    return {
        log: mock(),
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
    };
}

describe("createConsoleLogger", () => {
    test("routes levels to the expected console methods", () => {
        const consoleMock = createConsoleMock();
        const logger = createConsoleLogger({
            level: "debug",
            timestamps: false,
            console: consoleMock,
        });

        logger.log("plain");
        logger.debug("debug");
        logger.info("info");
        logger.warn("warn");
        logger.error("error");
        logger.fatal("fatal");

        expect(consoleMock.log).toHaveBeenCalledWith("LOG plain");
        expect(consoleMock.debug).toHaveBeenCalledWith("DEBUG debug");
        expect(consoleMock.info).toHaveBeenCalledWith("INFO info");
        expect(consoleMock.warn).toHaveBeenCalledWith("WARN warn");
        expect(consoleMock.error).toHaveBeenNthCalledWith(1, "ERROR error");
        expect(consoleMock.error).toHaveBeenNthCalledWith(2, "FATAL fatal");
    });

    test("filters lower levels", () => {
        const consoleMock = createConsoleMock();
        const logger = createConsoleLogger({
            level: "warn",
            timestamps: false,
            console: consoleMock,
        });

        logger.debug("debug");
        logger.info("info");
        logger.warn("warn");

        expect(consoleMock.debug).not.toHaveBeenCalled();
        expect(consoleMock.info).not.toHaveBeenCalled();
        expect(consoleMock.warn).toHaveBeenCalledWith("WARN warn");
    });

    test("emits normalized attributes separately", () => {
        const consoleMock = createConsoleMock();
        const logger = createConsoleLogger({
            timestamps: false,
            console: consoleMock,
        });

        logger.info("api started", "port", 4321, "healthy", true);

        expect(consoleMock.info).toHaveBeenCalledWith("INFO api started", {
            port: 4321,
            healthy: true,
        });
    });

    test("includes timestamps by default", () => {
        const consoleMock = createConsoleMock();
        const logger = createConsoleLogger({
            console: consoleMock,
        });

        logger.info("timed");

        const [line] = consoleMock.info.mock.calls[0]!;
        expect(line).toMatch(/^\[[^\]]+\] INFO timed$/);
    });
});
