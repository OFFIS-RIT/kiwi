import { createChatSystemPrompt, getProviderOptions } from "@kiwi/ai";
import { linkifyResearchCitations, runMcpResearch } from "@kiwi/ai/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Elysia } from "elysia";
import * as Effect from "effect/Effect";
import { z } from "zod/v4";
import { assertCanViewGraphWithRootOwner } from "../lib/graph/access";
import { listAccessibleGraphs } from "../lib/graph/list";
import { getGraphResearchRuntime, resolveCitationDocumentLink } from "../lib/chat";
import { getPublicApiBaseUrl } from "../lib/project-file-url";
import { mcpAuthMiddleware } from "../middleware/auth";
import { assertPermissions } from "../middleware/permissions";
import { env } from "../env";
import { API_ERROR_CODES } from "../types";

const getGraphsOutput = z.object({
    graphs: z.array(z.record(z.string(), z.unknown())),
});

const researchInput = {
    graphId: z.string().trim().min(1).describe("The graph/project identifier to search."),
    question: z.string().trim().min(1).describe("The research question to answer."),
};

const researchOutput = z.object({
    graphId: z.string(),
    answer: z.string(),
});

function jsonRpcErrorResponse(status: number, code: number, message: string) {
    return new Response(
        JSON.stringify({
            jsonrpc: "2.0",
            error: {
                code,
                message,
            },
            id: null,
        }),
        {
            status,
            headers: {
                "content-type": "application/json",
            },
        }
    );
}

function assertMcpGraphViewPermission(headers: Headers): Effect.Effect<void, Error> {
    return Effect.matchEffect(assertPermissions(headers, { graph: ["view"] }, { apiKeyOnly: true }), {
        onFailure: (error) => {
            if (error instanceof Error && error.message === API_ERROR_CODES.FORBIDDEN) {
                return Effect.fail(new Error("This API key does not have permission to view graphs."));
            }

            return Effect.fail(new Error("Unable to verify permissions for this MCP tool."));
        },
        onSuccess: () => Effect.succeed(undefined),
    });
}

function assertMcpCanViewGraph(
    ...args: Parameters<typeof assertCanViewGraphWithRootOwner>
): ReturnType<typeof assertCanViewGraphWithRootOwner> {
    return Effect.matchEffect(assertCanViewGraphWithRootOwner(...args), {
        onFailure: (error) => {
            if (
                error instanceof Error &&
                (error.message === API_ERROR_CODES.FORBIDDEN || error.message === API_ERROR_CODES.GRAPH_NOT_FOUND)
            ) {
                return Effect.fail(new Error("Graph not found or this API key does not have permission to view it."));
            }

            return Effect.fail(new Error("Unable to verify access to this graph."));
        },
        onSuccess: (value) => Effect.succeed(value),
    });
}

export const mcpRoute = new Elysia({ prefix: "/mcp" })
    .use(mcpAuthMiddleware)
    .post("/", async ({ request, session, user }) => {
        if (!session || !user) {
            return jsonRpcErrorResponse(401, -32001, "Unauthorized");
        }

        const server = new McpServer({
            name: "kiwi-mcp",
            version: "0.2.0",
        });
        server.tool("get_graphs", "List the graphs/projects that the current API key can access.", async () => {
            await Effect.runPromise(assertMcpGraphViewPermission(request.headers));

            const graphs = await Effect.runPromise(listAccessibleGraphs(user));

            return {
                content: [
                    {
                        type: "text",
                        text:
                            graphs.length === 0
                                ? "No graphs available."
                                : [
                                      "Available graphs:",
                                      ...graphs.map((graph) => `- ${graph.graph_name} (${graph.graph_id})`),
                                  ].join("\n"),
                    },
                ],
                structuredContent: getGraphsOutput.parse({ graphs }),
            };
        });

        server.tool(
            "research",
            "Research a question against one graph/project and return a Markdown answer with document links.",
            researchInput,
            async ({ graphId, question }) => {
                await Effect.runPromise(assertMcpGraphViewPermission(request.headers));
                const { rootOwner } = await Effect.runPromise(assertMcpCanViewGraph(user, graphId));

                const { client, promptGuidance, tools } = await Effect.runPromise(
                    getGraphResearchRuntime(graphId, {
                        toolset: "mcp",
                        user,
                        rootOwner,
                    })
                );

                const result = await Effect.runPromise(
                    runMcpResearch({
                        model: client.text!,
                        question,
                        system: createChatSystemPrompt({ includeClientTools: false }),
                        tools,
                        promptGuidance,
                        providerOptions: getProviderOptions({ thinking: "medium" }),
                        transformAnswer: (text) =>
                            linkifyResearchCitations(text, (citation) =>
                                resolveCitationDocumentLink(graphId, citation, {
                                    baseUrl: getPublicApiBaseUrl(request, env.API_URL),
                                    signed: true,
                                })
                            ),
                    })
                );

                return {
                    content: [{ type: "text", text: result.answer }],
                    structuredContent: researchOutput.parse({
                        graphId,
                        answer: result.answer,
                    }),
                };
            }
        );

        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });

        await server.connect(transport);

        try {
            return await transport.handleRequest(request);
        } finally {
            await transport.close();
            await server.close();
        }
    })
    .get("/", () => jsonRpcErrorResponse(405, -32000, "Method not allowed"))
    .delete("/", () => jsonRpcErrorResponse(405, -32000, "Method not allowed"))
    .options("/", () => jsonRpcErrorResponse(405, -32000, "Method not allowed"));
