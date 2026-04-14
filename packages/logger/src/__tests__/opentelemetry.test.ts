import { describe, expect, test } from "bun:test";
import { createOpenTelemetryLogger, type LogRecordExporter } from "../opentelemetry";

type ExportedRecord = {
    body?: unknown;
    severityText?: string;
    attributes?: Record<string, unknown>;
    resource?: {
        attributes?: Record<string, unknown>;
    };
};

class MockExporter implements LogRecordExporter {
    public readonly exportedRecords: ExportedRecord[] = [];
    public shutdownCalls = 0;
    public forceFlushCalls = 0;

    export(records: ExportedRecord[], resultCallback: Parameters<LogRecordExporter["export"]>[1]): void {
        this.exportedRecords.push(...records);
        resultCallback({ code: 0 } as never);
    }

    async shutdown() {
        this.shutdownCalls += 1;
    }

    async forceFlush() {
        this.forceFlushCalls += 1;
    }
}

describe("createOpenTelemetryLogger", () => {
    test("emits body severity and attributes", async () => {
        const exporter = new MockExporter();
        const logger = createOpenTelemetryLogger({
            serviceName: "kiwi-api",
            processor: "simple",
            exporter,
        });

        logger.error("request failed", { statusCode: 500, retryable: false });
        await logger.flush?.();

        expect(exporter.exportedRecords).toHaveLength(1);
        expect(exporter.exportedRecords[0]?.body).toBe("request failed");
        expect(exporter.exportedRecords[0]?.severityText).toBe("ERROR");
        expect(exporter.exportedRecords[0]?.attributes).toMatchObject({
            statusCode: 500,
            retryable: false,
        });
        expect(exporter.exportedRecords[0]?.resource?.attributes?.["service.name"]).toBe("kiwi-api");
    });

    test("filters by configured level", async () => {
        const exporter = new MockExporter();
        const logger = createOpenTelemetryLogger({
            serviceName: "kiwi-api",
            level: "warn",
            processor: "simple",
            exporter,
        });

        logger.info("skip me");
        logger.warn("keep me");
        await logger.flush?.();

        expect(exporter.exportedRecords).toHaveLength(1);
        expect(exporter.exportedRecords[0]?.body).toBe("keep me");
    });

    test("delegates shutdown to the provider/exporter pipeline", async () => {
        const exporter = new MockExporter();
        const logger = createOpenTelemetryLogger({
            serviceName: "kiwi-api",
            processor: "simple",
            exporter,
        });

        await logger.shutdown?.();

        expect(exporter.shutdownCalls).toBe(1);
    });
});
