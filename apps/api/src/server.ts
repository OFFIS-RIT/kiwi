import { cors } from "@elysiajs/cors";
import { info } from "@kiwi/logger";
import { Elysia } from "elysia";
import { env } from "./env";
import { initLogger, shutdownLogger } from "./logger";
import { authMiddleware } from "./middleware/auth";
import { authRoute } from "./routes/auth";
import { chatRoute } from "./routes/chat";
import { graphRoute } from "./routes/graph";
import { groupRoute } from "./routes/group";
import { mcpRoute } from "./routes/mcp";

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
                      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
                      allowedHeaders: ["Content-Type", "Authorization"],
                      exposeHeaders: ["Content-Length", "Content-Range"],
                      credentials: true,
                  }
                : undefined
        )
    )
    .use(mcpRoute)
    .use(authMiddleware)
    .use(authRoute)
    .use(chatRoute)
    .use(graphRoute)
    .use(groupRoute)
    .get("/health", () => ({ status: "ok" }))
    .listen(4321);

info("api server started", {
    host: app.server?.hostname ?? "unknown",
    port: app.server?.port ?? 4321,
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
