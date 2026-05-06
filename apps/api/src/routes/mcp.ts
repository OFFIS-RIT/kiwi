import { createChatSystemPrompt, getProviderOptions } from "@kiwi/ai";
import { linkifyResearchCitations, runMcpResearch } from "@kiwi/ai/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { Elysia } from "elysia";
import { z } from "zod/v3";
import { assertCanViewGraph } from "../lib/graph-access";
import { listAccessibleGraphs } from "../lib/graph-list";
import { getGraphResearchRuntime, resolveCitationDocumentLink } from "../lib/chat";
import { mcpAuthMiddleware } from "../middleware/auth";
import { assertPermissions } from "../middleware/permissions";

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

        server.tool(
            "get_graphs",
            "List the graphs/projects that the current API key can access.",
            async () => {
                await assertPermissions(request.headers, { graph: ["view"] }, { apiKeyOnly: true });

                const graphs = await listAccessibleGraphs(user);

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
            }
        );

        server.registerTool(
            "research",
            {
                title: "Research",
                description:
                    "Research a question against one graph/project and return a Markdown answer with document links.",
                inputSchema: researchInput as unknown as ZodRawShapeCompat,
            },
            (async (input: unknown) => {
                const { graphId, question } = z.object(researchInput).parse(input);

                await assertPermissions(request.headers, { graph: ["view"] }, { apiKeyOnly: true });
                await assertCanViewGraph(user, graphId);

                const { client, prompt, tools } = await getGraphResearchRuntime(graphId);
                // oxlint-disable-next-line no-unused-vars -- MCP research is stateless, so omit the client-only clarification tool.
                const { ask_clarifying_questions: askClarifyingQuestions, ...researchTools } = tools;

                const result = await runMcpResearch({
                    model: client.text!,
                    question,
                    system: createChatSystemPrompt(prompt),
                    tools: researchTools,
                    providerOptions: getProviderOptions({ thinking: "medium" }),
                    transformAnswer: (text) =>
                        linkifyResearchCitations(text, (citation) => resolveCitationDocumentLink(graphId, citation)),
                });

                return {
                    content: [{ type: "text", text: result.answer }],
                    structuredContent: researchOutput.parse({
                        graphId,
                        answer: result.answer,
                    }),
                };
            }) as unknown as ToolCallback<ZodRawShapeCompat>
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
