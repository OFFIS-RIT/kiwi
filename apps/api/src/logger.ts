import { createConsoleLogger, init, shutdown, type LogLevel, type LoggerInstance } from "@kiwi/logger";
import { ATTR_DEPLOYMENT_ENVIRONMENT, createOpenTelemetryLogger } from "@kiwi/logger/opentelemetry";

const validLevels = new Set<LogLevel>(["log", "debug", "info", "warn", "error", "fatal"]);

let initialized = false;

function getLogLevel(): LogLevel {
    const value = process.env.LOG_LEVEL?.toLowerCase();
    if (value && validLevels.has(value as LogLevel)) {
        return value as LogLevel;
    }

    return "info";
}

function resolveOtlpEndpoint() {
    return process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

function resolveOtlpHeaders() {
    const rawHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
    if (!rawHeaders) {
        return undefined;
    }

    const headers: Record<string, string> = {};
    for (const entry of rawHeaders.split(",")) {
        const trimmedEntry = entry.trim();
        if (!trimmedEntry) {
            continue;
        }

        const separatorIndex = trimmedEntry.indexOf("=");
        if (separatorIndex === -1) {
            continue;
        }

        const key = trimmedEntry.slice(0, separatorIndex).trim();
        const value = trimmedEntry.slice(separatorIndex + 1).trim();
        if (key) {
            headers[key] = value;
        }
    }

    return Object.keys(headers).length > 0 ? headers : undefined;
}

export function initLogger() {
    if (initialized) {
        return;
    }

    const level = getLogLevel();
    const instances: LoggerInstance[] = [
        createConsoleLogger({
            level,
        }),
    ];

    const endpoint = resolveOtlpEndpoint();
    if (endpoint) {
        instances.push(
            createOpenTelemetryLogger({
                serviceName: "kiwi-api",
                serviceNamespace: "kiwi",
                level,
                endpoint,
                headers: resolveOtlpHeaders(),
                resourceAttributes: process.env.NODE_ENV
                    ? {
                          [ATTR_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV,
                      }
                    : undefined,
            })
        );
    }

    init(...instances);
    initialized = true;
}

export async function shutdownLogger() {
    if (!initialized) {
        return;
    }

    await shutdown();
    initialized = false;
}
