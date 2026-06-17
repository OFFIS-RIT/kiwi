import { cors } from "@elysiajs/cors";
import * as Effect from "effect/Effect";
import { runDatabaseEffect } from "@kiwi/db/effect";
import { bootstrapLegacyModelsFromEnv } from "@kiwi/ai/models";
import { info, warn as logWarn } from "@kiwi/logger";
import { Elysia } from "elysia";
import { ensureMasterUser } from "./controllers/auth/ensure-master-user";
import { env } from "./env";
import { checkArchiveUploadTools } from "./lib/archive-upload";
import { initLogger, shutdownLogger } from "./logger";
import { authMiddleware } from "./middleware/auth";
import { authRoute } from "./routes/auth";
import { chatRoute } from "./routes/chat";
import { chatLibraryRoute } from "./routes/chat-library";
import { fileTypesRoute } from "./routes/file-types";
import { graphFilesRoute } from "./routes/graph-files";
import { connectorRoute, repositoryGraphBindingRoute } from "./routes/connectors";
import { connectorWebhookRoute } from "./routes/connector-webhooks";
import { graphRoute } from "./routes/graph";
import { graphSuggestionsRoute } from "./routes/graph-suggestions";
import { mcpRoute } from "./routes/mcp";
import { modelsRoute } from "./routes/models";
import { promptsRoute } from "./routes/prompts";
import { searchRoute } from "./routes/search";
import { teamChatRoute } from "./routes/team-chat";
import { teamRoute } from "./routes/team";

initLogger();
const archiveToolCheck = await Effect.runPromise(checkArchiveUploadTools());
if (!archiveToolCheck.ok) {
    logWarn("archive upload extraction tools are missing", { missingTools: archiveToolCheck.missing });
}
const legacyModelBootstrap = await runDatabaseEffect(bootstrapLegacyModelsFromEnv({ secret: env.AUTH_SECRET }));
await runDatabaseEffect(ensureMasterUser());

const trustedOrigins =
    env.TRUSTED_ORIGINS?.split(",")
        .map((origin: string) => origin.trim())
        .filter(Boolean) ?? [];

const app = new Elysia({
    serve: {
        maxRequestBodySize: 4 * 1024 * 1024 * 1024,
    },
})
    .use(
        cors(
            trustedOrigins.length > 0
                ? {
                      origin: trustedOrigins,
                      methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
                      allowedHeaders: ["Content-Type", "Authorization", "Range", "If-Range"],
                      exposeHeaders: ["Accept-Ranges", "Content-Disposition", "Content-Length", "Content-Range"],
                      credentials: true,
                  }
                : undefined
        )
    )
    .use(mcpRoute)
    .use(connectorWebhookRoute)
    .use(authMiddleware)
    .use(authRoute)
    .use(chatRoute)
    .use(chatLibraryRoute)
    .use(fileTypesRoute)
    .use(graphFilesRoute)
    .use(graphSuggestionsRoute)
    .use(connectorRoute)
    .use(repositoryGraphBindingRoute)
    .use(graphRoute)
    .use(modelsRoute)
    .use(promptsRoute)
    .use(searchRoute)
    .use(teamChatRoute)
    .use(teamRoute)
    .get("/health", () => ({ status: "ok" }))
    .listen(4321);

info("api server started", {
    host: app.server?.hostname ?? "unknown",
    port: app.server?.port ?? 4321,
    legacyModelSeedCount: legacyModelBootstrap.seededModelCount,
});

async function handleShutdown(signal: string) {
    info("api server shutting down", { signal });
    await Effect.runPromise(shutdownLogger());
    process.exit(0);
}

process.once("SIGINT", () => {
    void handleShutdown("SIGINT");
});

process.once("SIGTERM", () => {
    void handleShutdown("SIGTERM");
});
