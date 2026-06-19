import { createChatSystemPrompt, getProviderOptions } from "@kiwi/ai";
import { linkifyResearchCitations, runMcpResearch } from "@kiwi/ai/mcp";
import { DatabaseLayer, runDatabaseEffect, type Database } from "@kiwi/db/effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as Effect from "effect/Effect";
import { z } from "zod/v4";
import { assertCanViewGraphWithRootOwner, type GraphRecord, type RootOwner } from "../../lib/graph/access";
import { listAccessibleGraphs } from "../../lib/graph/list";
import { getGraphResearchRuntime, resolveCitationDocumentLink } from "../../lib/chat";
import { getPublicApiBaseUrl } from "../../lib/project-file-url";
import { assertPermissions } from "../../middleware/permissions";
import { env } from "../../env";
import { API_ERROR_CODES } from "../../types";
import type { AuthSession, AuthUser } from "../../middleware/auth";
import { mcpJsonRpcErrorResponse } from "./responses";

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

type GraphAccessWithRootOwner = {
    graph: GraphRecord;
    rootOwner: RootOwner;
};

export type McpRequestContext = {
    request: Request;
    user: AuthUser;
};

export type McpRouteContext = {
    request: Request;
    session: AuthSession;
    user: AuthUser | null | undefined;
};

function assertMcpGraphViewPermission(headers: Headers): Effect.Effect<void, Error, Database> {
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
    user: AuthUser,
    graphId: string
): Effect.Effect<GraphAccessWithRootOwner, Error, Database> {
    return Effect.matchEffect(assertCanViewGraphWithRootOwner(user, graphId), {
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

function getGraphsToolResult({ request, user }: McpRequestContext) {
    return Effect.gen(function* () {
        yield* assertMcpGraphViewPermission(request.headers);

        const graphs = yield* listAccessibleGraphs(user);

        return {
            content: [
                {
                    type: "text" as const,
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
}

function researchToolResult({ request, user }: McpRequestContext, input: { graphId: string; question: string }) {
    return Effect.gen(function* () {
        yield* assertMcpGraphViewPermission(request.headers);
        const { rootOwner } = yield* assertMcpCanViewGraph(user, input.graphId);

        const { client, promptGuidance, tools } = yield* getGraphResearchRuntime(input.graphId, {
            toolset: "mcp",
            user,
            rootOwner,
        });

        const result = yield* runMcpResearch({
            model: client.text!,
            question: input.question,
            system: createChatSystemPrompt({ includeClientTools: false }),
            tools,
            promptGuidance,
            providerOptions: getProviderOptions({ thinking: "medium" }),
            transformAnswer: (text) =>
                linkifyResearchCitations(text, (citation) =>
                    Effect.provide(
                        resolveCitationDocumentLink(input.graphId, citation, {
                            baseUrl: getPublicApiBaseUrl(request, env.API_URL),
                            signed: true,
                        }),
                        DatabaseLayer
                    )
                ),
        });

        return {
            content: [{ type: "text" as const, text: result.answer }],
            structuredContent: researchOutput.parse({
                graphId: input.graphId,
                answer: result.answer,
            }),
        };
    });
}

function registerMcpTools(server: McpServer, context: McpRequestContext) {
    server.tool("get_graphs", "List the graphs/projects that the current API key can access.", async () =>
        runDatabaseEffect(getGraphsToolResult(context))
    );

    server.tool(
        "research",
        "Research a question against one graph/project and return a Markdown answer with document links.",
        researchInput,
        async ({ graphId, question }) => runDatabaseEffect(researchToolResult(context, { graphId, question }))
    );
}

function createMcpServer(context: McpRequestContext) {
    const server = new McpServer({
        name: "kiwi-mcp",
        version: "0.2.0",
    });

    registerMcpTools(server, context);

    return server;
}

export function handleMcpRouteRequest(context: McpRouteContext): Promise<Response> {
    if (!context.session || !context.user) {
        return Promise.resolve(mcpJsonRpcErrorResponse(401, -32001, "Unauthorized"));
    }

    return handleMcpRequest({ request: context.request, user: context.user });
}

export async function handleMcpRequest(context: McpRequestContext): Promise<Response> {
    const server = createMcpServer(context);
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });

    await server.connect(transport);

    try {
        return await transport.handleRequest(context.request);
    } finally {
        await transport.close();
        await server.close();
    }
}
