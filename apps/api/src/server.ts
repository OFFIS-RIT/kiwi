import * as Effect from "effect/Effect";
import { bootstrapLegacyModelsFromEnv } from "@kiwi/ai/models";
import { disposeDatabaseRuntime } from "@kiwi/db/effect";
import { info, warn as logWarn } from "@kiwi/logger";
import { createApiApp } from "./app";
import { ensureMasterUser } from "./controllers/auth/ensure-master-user";
import { env } from "./env";
import { checkArchiveUploadTools } from "./lib/archive-upload";
import { initLogger, shutdownLogger } from "./logger";
import { runApiEffect } from "./effect";

initLogger();
const archiveToolCheck = await Effect.runPromise(checkArchiveUploadTools());
if (!archiveToolCheck.ok) {
    logWarn("archive upload extraction tools are missing", { missingTools: archiveToolCheck.missing });
}
const legacyModelBootstrap = await runApiEffect(bootstrapLegacyModelsFromEnv({ env: process.env }));
await runApiEffect(ensureMasterUser());

const trustedOrigins =
    env.TRUSTED_ORIGINS?.split(",")
        .map((origin: string) => origin.trim())
        .filter(Boolean) ?? [];

const app = createApiApp({ trustedOrigins }).listen(4321);

info("api server started", {
    host: app.server?.hostname ?? "unknown",
    port: app.server?.port ?? 4321,
    legacyModelSeedCount: legacyModelBootstrap.seededModelCount,
});

async function handleShutdown(signal: string) {
    info("api server shutting down", { signal });
    await disposeDatabaseRuntime();
    await Effect.runPromise(shutdownLogger());
    process.exit(0);
}

process.once("SIGINT", () => {
    void handleShutdown("SIGINT");
});

process.once("SIGTERM", () => {
    void handleShutdown("SIGTERM");
});
