import { cors } from "@elysiajs/cors";
import { info } from "@kiwi/logger";
import { Elysia } from "elysia";
import { DEFAULT_CONTEXT_WINDOW, env, isContextWindowDefaulted } from "./env";
import { initLogger, shutdownLogger } from "./logger";
import { authMiddleware } from "./middleware/auth";
import { authRoute } from "./routes/auth";
import { chatRoute } from "./routes/chat";
import { chatLibraryRoute } from "./routes/chat-library";
import { graphFilesRoute } from "./routes/graph-files";
import { graphRoute } from "./routes/graph";
import { graphSuggestionsRoute } from "./routes/graph-suggestions";
import { mcpRoute } from "./routes/mcp";
import { modelsRoute } from "./routes/models";
import { promptsRoute } from "./routes/prompts";
import { searchRoute } from "./routes/search";
import { teamChatRoute } from "./routes/team-chat";
import { teamRoute } from "./routes/team";

initLogger();

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
    .use(authMiddleware)
    .use(authRoute)
    .use(chatRoute)
    .use(chatLibraryRoute)
    .use(graphFilesRoute)
    .use(graphSuggestionsRoute)
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
    contextWindow: env.CONTEXT_WINDOW,
    ...(isContextWindowDefaulted
        ? {
              contextWindowNotice: `CONTEXT_WINDOW is not set; using ${DEFAULT_CONTEXT_WINDOW}. Set CONTEXT_WINDOW to your text model's context window for best compaction behavior.`,
          }
        : {}),
});

async function handleShutdown(signal: string) {
    info("api server shutting down", { signal });
    await shutdownLogger();
    process.exit(0);
}

process.once("SIGINT", () => {
    void handleShutdown("SIGINT");
});

process.once("SIGTERM", () => {
    void handleShutdown("SIGTERM");
});
