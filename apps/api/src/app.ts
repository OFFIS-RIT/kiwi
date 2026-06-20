import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { authMiddleware } from "./middleware/auth";
import { authRoute } from "./routes/auth";
import { chatRoute } from "./routes/chat";
import { chatLibraryRoute } from "./routes/chat-library";
import { fileTypesRoute } from "./routes/file-types";
import { graphFilesRoute } from "./routes/graph-files";
import { connectorRoute, connectorResourceBindingRoute } from "./routes/connectors";
import { connectorWebhookRoute } from "./routes/connector-webhooks";
import { graphRoute } from "./routes/graph";
import { graphSuggestionsRoute } from "./routes/graph-suggestions";
import { mcpRoute } from "./routes/mcp";
import { modelsRoute } from "./routes/models";
import { promptsRoute } from "./routes/prompts";
import { searchRoute } from "./routes/search";
import { teamChatRoute } from "./routes/team-chat";
import { teamRoute } from "./routes/team";

export type ApiAppOptions = {
    trustedOrigins: readonly string[];
};

export function createApiApp(options: ApiAppOptions) {
    return new Elysia({
        serve: {
            maxRequestBodySize: 4 * 1024 * 1024 * 1024,
        },
    })
        .use(
            cors(
                options.trustedOrigins.length > 0
                    ? {
                          origin: [...options.trustedOrigins],
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
        .use(connectorResourceBindingRoute)
        .use(graphRoute)
        .use(modelsRoute)
        .use(promptsRoute)
        .use(searchRoute)
        .use(teamChatRoute)
        .use(teamRoute)
        .get("/health", () => ({ status: "ok" }));
}
