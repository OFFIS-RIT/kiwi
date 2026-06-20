import { createChatSystemPrompt, getProviderOptions } from "@kiwi/ai";
import { linkifyResearchCitations, runMcpResearch } from "@kiwi/ai/mcp";
import { runDatabaseEffect, type Database as DatabaseContext } from "@kiwi/db/effect";
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
import { API_ERROR_CODES, internalServerError, isApiError, makeApiError, type ApiError } from "../../types";
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

function toMcpApiError(error: unknown, fallbackMessage: string): ApiError {
    return isApiError(error) ? error : internalServerError(fallbackMessage);
}

function assertMcpGraphViewPermission(headers: Headers): Effect.Effect<void, ApiError, DatabaseContext> {
    return Effect.matchEffect(assertPermissions(headers, { graph: ["view"] }, { apiKeyOnly: true }), {
        onFailure: (error) => {
            if (error.code === API_ERROR_CODES.FORBIDDEN) {
                return Effect.fail(
                    makeApiError(
                        403,
                        API_ERROR_CODES.FORBIDDEN,
                        "This API key does not have permission to view graphs."
                    )
                );
            }

            return Effect.fail(internalServerError("Unable to verify permissions for this MCP tool."));
        },
        onSuccess: () => Effect.succeed(undefined),
    });
}

function assertMcpCanViewGraph(
    user: AuthUser,
    graphId: string
): Effect.Effect<GraphAccessWithRootOwner, ApiError, DatabaseContext> {
    return Effect.matchEffect(assertCanViewGraphWithRootOwner(user, graphId), {
        onFailure: (error) => {
            const apiError = makeApiError(
                404,
                API_ERROR_CODES.GRAPH_NOT_FOUND,
                "Graph not found or this API key does not have permission to view it."
            );
            if (error instanceof Error) {
                if (error.message === API_ERROR_CODES.FORBIDDEN || error.message === API_ERROR_CODES.GRAPH_NOT_FOUND) {
                    return Effect.fail(apiError);
                }
            }

            return Effect.fail(internalServerError("Unable to verify access to this graph."));
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
    }).pipe(Effect.mapError((error) => toMcpApiError(error, "Unable to list graphs for this MCP tool.")));
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
                    resolveCitationDocumentLink(input.graphId, citation, {
                        baseUrl: getPublicApiBaseUrl(request, env.API_URL),
                        signed: true,
                    })
                ),
        });

        return {
            content: [{ type: "text" as const, text: result.answer }],
            structuredContent: researchOutput.parse({
                graphId: input.graphId,
                answer: result.answer,
            }),
        };
    }).pipe(Effect.mapError((error) => toMcpApiError(error, "Unable to complete research for this MCP tool.")));
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

export function handleMcpRequest(context: McpRequestContext): Promise<Response> {
    return Effect.runPromise(
        Effect.acquireUseRelease(
            Effect.tryPromise({
                try: async () => {
                    const server = createMcpServer(context);
                    const transport = new WebStandardStreamableHTTPServerTransport({
                        sessionIdGenerator: undefined,
                        enableJsonResponse: true,
                    });

                    await server.connect(transport);
                    return { server, transport };
                },
                catch: (error) => error,
            }),
            ({ transport }) =>
                Effect.tryPromise({
                    try: () => transport.handleRequest(context.request),
                    catch: (error) => error,
                }),
            ({ server, transport }) =>
                Effect.promise(async () => {
                    await transport.close();
                    await server.close();
                })
        )
    );
}
