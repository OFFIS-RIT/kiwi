import { Elysia } from "elysia";
import { handleMcpRouteRequest } from "../controllers/mcp/handle-request";
import { mcpJsonRpcErrorResponse } from "../controllers/mcp/responses";
import { mcpAuthMiddleware } from "../middleware/auth";

export const mcpRoute = new Elysia({ prefix: "/mcp" })
    .use(mcpAuthMiddleware)
    .post("/", ({ request, session, user }) => handleMcpRouteRequest({ request, session, user }))
    .get("/", () => mcpJsonRpcErrorResponse(405, -32000, "Method not allowed"))
    .delete("/", () => mcpJsonRpcErrorResponse(405, -32000, "Method not allowed"))
    .options("/", () => mcpJsonRpcErrorResponse(405, -32000, "Method not allowed"));
