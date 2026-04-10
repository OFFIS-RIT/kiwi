import { cors } from "@elysiajs/cors";
import { info } from "@kiwi/logger";
import { Elysia } from "elysia";
import { initLogger, shutdownLogger } from "./logger";
import { authMiddleware } from "./middleware/auth";
import { authRoute } from "./routes/auth";
import { chatRoute } from "./routes/chat";
import { graphRoute } from "./routes/graph";
import { groupRoute } from "./routes/group";
import { unitRoute } from "./routes/unit";

initLogger();

const app = new Elysia()
    .use(cors())
    .use(authMiddleware)
    .use(authRoute)
    .use(chatRoute)
    .use(graphRoute)
    .use(groupRoute)
    .use(unitRoute)
    .get("/health", () => ({ status: "ok" }))
    .listen(4321);

info("api server started", "host", app.server?.hostname ?? "unknown", "port", app.server?.port ?? 4321);

async function handleShutdown(signal: string) {
    info("api server shutting down", "signal", signal);
    await shutdownLogger();
    process.exit(0);
}

process.once("SIGINT", () => {
    void handleShutdown("SIGINT");
});

process.once("SIGTERM", () => {
    void handleShutdown("SIGTERM");
});
