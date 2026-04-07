import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
    BatchLogRecordProcessor,
    LoggerProvider,
    type LogRecordExporter,
    type LogRecordProcessor,
    SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_NAMESPACE,
    ATTR_SERVICE_VERSION,
    SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";
import { normalizeKeyvals } from "./normalize";
import type { LogLevel, LoggerInstance } from "./types";

export type OpenTelemetryLoggerOptions = {
    serviceName: string;
    serviceNamespace?: string;
    serviceVersion?: string;
    level?: LogLevel;
    endpoint?: string;
    headers?: Record<string, string>;
    resourceAttributes?: Record<string, string | number | boolean>;
    scopeName?: string;
    processor?: "batch" | "simple";
    exportTimeoutMillis?: number;
    exporter?: LogRecordExporter;
};

const levelPriority: Record<LogLevel, number> = {
    debug: 10,
    log: 20,
    info: 20,
    warn: 30,
    error: 40,
    fatal: 50,
};

const severityMap: Record<LogLevel, SeverityNumber> = {
    debug: SeverityNumber.DEBUG,
    log: SeverityNumber.INFO,
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
    fatal: SeverityNumber.FATAL,
};

function shouldLog(messageLevel: LogLevel, configuredLevel: LogLevel) {
    return levelPriority[messageLevel] >= levelPriority[configuredLevel];
}

function createResource(options: OpenTelemetryLoggerOptions) {
    const attributes: Record<string, string | number | boolean> = {
        [ATTR_SERVICE_NAME]: options.serviceName,
    };

    if (options.serviceNamespace) {
        attributes[ATTR_SERVICE_NAMESPACE] = options.serviceNamespace;
    }

    if (options.serviceVersion) {
        attributes[ATTR_SERVICE_VERSION] = options.serviceVersion;
    }

    if (options.resourceAttributes) {
        for (const [key, value] of Object.entries(options.resourceAttributes)) {
            attributes[key] = value;
        }
    }

    return resourceFromAttributes(attributes);
}

function createExporter(options: OpenTelemetryLoggerOptions) {
    return new OTLPLogExporter({
        url: options.endpoint,
        headers: options.headers,
        timeoutMillis: options.exportTimeoutMillis,
    });
}

function createProcessor(options: OpenTelemetryLoggerOptions, exporter: LogRecordExporter): LogRecordProcessor {
    if (options.processor === "simple") {
        return new SimpleLogRecordProcessor(exporter);
    }

    return new BatchLogRecordProcessor(exporter);
}

class OpenTelemetryLogger implements LoggerInstance {
    private readonly level: LogLevel;
    private readonly provider: LoggerProvider;
    private readonly logger: ReturnType<LoggerProvider["getLogger"]>;

    constructor(options: OpenTelemetryLoggerOptions) {
        this.level = options.level ?? "info";

        const exporter = options.exporter ?? createExporter(options);
        const provider = new LoggerProvider({
            resource: createResource(options),
            processors: [createProcessor(options, exporter)],
        });
        logs.setGlobalLoggerProvider(provider);

        this.provider = provider;
        this.logger = provider.getLogger(options.scopeName ?? options.serviceName);
    }

    private emit(level: LogLevel, message: string, keyvals: unknown[]) {
        if (!shouldLog(level, this.level)) {
            return;
        }

        const { attributes } = normalizeKeyvals(keyvals);
        this.logger.emit({
            body: message,
            severityNumber: severityMap[level],
            severityText: level.toUpperCase(),
            attributes,
        });
    }

    log(message: string, ...keyvals: unknown[]) {
        this.emit("log", message, keyvals);
    }

    debug(message: string, ...keyvals: unknown[]) {
        this.emit("debug", message, keyvals);
    }

    info(message: string, ...keyvals: unknown[]) {
        this.emit("info", message, keyvals);
    }

    warn(message: string, ...keyvals: unknown[]) {
        this.emit("warn", message, keyvals);
    }

    error(message: string, ...keyvals: unknown[]) {
        this.emit("error", message, keyvals);
    }

    fatal(message: string, ...keyvals: unknown[]) {
        this.emit("fatal", message, keyvals);
    }

    async flush() {
        await this.provider.forceFlush();
    }

    async shutdown() {
        await this.provider.shutdown();
    }
}

export function createOpenTelemetryLogger(options: OpenTelemetryLoggerOptions): LoggerInstance {
    return new OpenTelemetryLogger(options);
}

export { SEMRESATTRS_DEPLOYMENT_ENVIRONMENT as ATTR_DEPLOYMENT_ENVIRONMENT };
export type { LogRecordExporter };
