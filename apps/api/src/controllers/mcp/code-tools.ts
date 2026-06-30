import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Effect from "effect/Effect";
import { z } from "zod/v4";
import type { Database as DatabaseContext } from "@kiwi/db/effect";
import {
    CODE_GRAPH_LAYER_NAMES,
    getFastCodeGraphReadAdapter,
    type CodeGetFileOutlineInput,
    type CodeGetFileOutlineResult,
    type CodeGetRelationshipsInput,
    type CodeGetRelationshipsResult,
    type CodeListFilesInput,
    type CodeListFilesResult,
    type CodeSearchSymbolsInput,
    type CodeSearchSymbolsResult,
    type CodeTraceCallsInput,
    type CodeTraceCallsResult,
    type FastCodeGraphReadAdapter,
} from "../../lib/code/fast-layer-read";
import { internalServerError, isApiError, type ApiError } from "../../types";

export const MCP_CODE_TOOL_NAMES = [
    "code_list_files",
    "code_search_symbols",
    "code_get_file_outline",
    "code_get_relationships",
    "code_trace_calls",
] as const;

const graphIdSchema = z.string().trim().min(1).describe("The graph/project identifier to inspect.");
const branchSchema = z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional repository branch to inspect. Defaults to the indexed repository default branch.");
const pathPrefixSchema = z.string().trim().min(1).optional().describe("Optional repository-relative path prefix.");
const limitSchema = z.number().int().min(1).max(100).optional().describe("Maximum number of results to return.");
const symbolIdSchema = z.string().trim().min(1).describe("The fast code graph symbol/node identifier.");

export const codeListFilesInput = {
    graphId: graphIdSchema,
    branch: branchSchema,
    pathPrefix: pathPrefixSchema,
    query: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional substring to match against repository-relative paths."),
    limit: limitSchema,
};

export const codeSearchSymbolsInput = {
    graphId: graphIdSchema,
    branch: branchSchema,
    query: z.string().trim().min(1).describe("The symbol name or substring to search for."),
    kind: z.string().trim().min(1).optional().describe("Optional symbol kind filter."),
    pathPrefix: pathPrefixSchema,
    limit: limitSchema,
};

export const codeGetFileOutlineInput = {
    graphId: graphIdSchema,
    branch: branchSchema,
    path: z.string().trim().min(1).describe("The repository-relative file path to outline."),
};

export const codeGetRelationshipsInput = {
    graphId: graphIdSchema,
    branch: branchSchema,
    symbolId: z.string().trim().min(1).optional().describe("Optional fast code graph symbol/node identifier."),
    path: z.string().trim().min(1).optional().describe("Optional repository-relative file path filter."),
    relationshipType: z.string().trim().min(1).optional().describe("Optional relationship type filter."),
    limit: limitSchema,
};

export const codeTraceCallsInput = {
    graphId: graphIdSchema,
    branch: branchSchema,
    symbolId: symbolIdSchema,
    direction: z.enum(["callers", "callees"]).optional().describe("Trace incoming callers or outgoing callees."),
    depth: z.number().int().min(1).max(5).optional().describe("Maximum call depth to trace."),
    limit: limitSchema,
};

const sourceRangeOutput = z.object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
});

const unavailableOutput = z.object({
    status: z.literal("unavailable"),
    graphId: z.string(),
    reason: z.enum(["storage_not_configured", "fast_code_graph_not_indexed"]),
    layerNames: z.array(z.enum(CODE_GRAPH_LAYER_NAMES)),
    message: z.string(),
});

const fileSummaryOutput = z.object({
    path: z.string(),
    language: z.string().optional(),
    repository: z.string().optional(),
    symbolCount: z.number().int().nonnegative().optional(),
});

const symbolOutput = z.object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    path: z.string(),
    range: sourceRangeOutput.optional(),
});

const outlineEntryOutput = symbolOutput.extend({
    parentId: z.string().optional(),
});

const relationshipOutput = z.object({
    id: z.string(),
    type: z.string(),
    fromId: z.string(),
    toId: z.string(),
    fromName: z.string().optional(),
    toName: z.string().optional(),
    path: z.string().optional(),
});

const callTraceStepOutput = z.object({
    fromId: z.string(),
    toId: z.string(),
    fromName: z.string().optional(),
    toName: z.string().optional(),
    path: z.string().optional(),
});

const codeListFilesOutput = z.union([
    unavailableOutput,
    z.object({ status: z.literal("ok"), graphId: z.string(), files: z.array(fileSummaryOutput) }),
]);

const codeSearchSymbolsOutput = z.union([
    unavailableOutput,
    z.object({ status: z.literal("ok"), graphId: z.string(), symbols: z.array(symbolOutput) }),
]);

const codeGetFileOutlineOutput = z.union([
    unavailableOutput,
    z.object({ status: z.literal("ok"), graphId: z.string(), path: z.string(), outline: z.array(outlineEntryOutput) }),
]);

const codeGetRelationshipsOutput = z.union([
    unavailableOutput,
    z.object({ status: z.literal("ok"), graphId: z.string(), relationships: z.array(relationshipOutput) }),
]);

const codeTraceCallsOutput = z.union([
    unavailableOutput,
    z.object({
        status: z.literal("ok"),
        graphId: z.string(),
        symbolId: z.string(),
        direction: z.enum(["callers", "callees"]),
        steps: z.array(callTraceStepOutput),
    }),
]);

const codeListFilesInputObject = z.object(codeListFilesInput);
const codeSearchSymbolsInputObject = z.object(codeSearchSymbolsInput);
const codeGetFileOutlineInputObject = z.object(codeGetFileOutlineInput);
const codeGetRelationshipsInputObject = z.object(codeGetRelationshipsInput);
const codeTraceCallsInputObject = z.object(codeTraceCallsInput);

export type McpCodeGraphAuthorizer = (graphId: string) => Effect.Effect<void, ApiError, DatabaseContext>;
export type McpEffectRunner = <T>(effect: Effect.Effect<T, ApiError, DatabaseContext>) => Promise<T>;

type ToolResult<TStructuredContent> = {
    content: Array<{ type: "text"; text: string }>;
    structuredContent: TStructuredContent;
};

function toMcpCodeToolError(error: unknown): ApiError {
    return isApiError(error)
        ? error
        : internalServerError("Unable to query fast code graph storage for this MCP tool.");
}

function resultText(
    toolName: (typeof MCP_CODE_TOOL_NAMES)[number],
    result: { status: "ok" | "unavailable"; message?: string }
) {
    if (result.status === "unavailable") {
        return `${toolName}: ${result.message}`;
    }

    return JSON.stringify(result, null, 2);
}

function makeToolResult<TStructuredContent>(
    toolName: (typeof MCP_CODE_TOOL_NAMES)[number],
    result: TStructuredContent & { status: "ok" | "unavailable"; message?: string }
): ToolResult<TStructuredContent> {
    return {
        content: [{ type: "text", text: resultText(toolName, result) }],
        structuredContent: result,
    };
}

export function codeListFilesToolResult(
    authorizeGraph: McpCodeGraphAuthorizer,
    input: CodeListFilesInput,
    adapter: FastCodeGraphReadAdapter = getFastCodeGraphReadAdapter()
): Effect.Effect<ToolResult<CodeListFilesResult>, ApiError, DatabaseContext> {
    return Effect.gen(function* () {
        yield* authorizeGraph(input.graphId);
        const result = yield* adapter.listFiles(input);
        return makeToolResult("code_list_files", codeListFilesOutput.parse(result));
    }).pipe(Effect.mapError(toMcpCodeToolError));
}

export function codeSearchSymbolsToolResult(
    authorizeGraph: McpCodeGraphAuthorizer,
    input: CodeSearchSymbolsInput,
    adapter: FastCodeGraphReadAdapter = getFastCodeGraphReadAdapter()
): Effect.Effect<ToolResult<CodeSearchSymbolsResult>, ApiError, DatabaseContext> {
    return Effect.gen(function* () {
        yield* authorizeGraph(input.graphId);
        const result = yield* adapter.searchSymbols(input);
        return makeToolResult("code_search_symbols", codeSearchSymbolsOutput.parse(result));
    }).pipe(Effect.mapError(toMcpCodeToolError));
}

export function codeGetFileOutlineToolResult(
    authorizeGraph: McpCodeGraphAuthorizer,
    input: CodeGetFileOutlineInput,
    adapter: FastCodeGraphReadAdapter = getFastCodeGraphReadAdapter()
): Effect.Effect<ToolResult<CodeGetFileOutlineResult>, ApiError, DatabaseContext> {
    return Effect.gen(function* () {
        yield* authorizeGraph(input.graphId);
        const result = yield* adapter.getFileOutline(input);
        return makeToolResult("code_get_file_outline", codeGetFileOutlineOutput.parse(result));
    }).pipe(Effect.mapError(toMcpCodeToolError));
}

export function codeGetRelationshipsToolResult(
    authorizeGraph: McpCodeGraphAuthorizer,
    input: CodeGetRelationshipsInput,
    adapter: FastCodeGraphReadAdapter = getFastCodeGraphReadAdapter()
): Effect.Effect<ToolResult<CodeGetRelationshipsResult>, ApiError, DatabaseContext> {
    return Effect.gen(function* () {
        yield* authorizeGraph(input.graphId);
        const result = yield* adapter.getRelationships(input);
        return makeToolResult("code_get_relationships", codeGetRelationshipsOutput.parse(result));
    }).pipe(Effect.mapError(toMcpCodeToolError));
}

export function codeTraceCallsToolResult(
    authorizeGraph: McpCodeGraphAuthorizer,
    input: CodeTraceCallsInput,
    adapter: FastCodeGraphReadAdapter = getFastCodeGraphReadAdapter()
): Effect.Effect<ToolResult<CodeTraceCallsResult>, ApiError, DatabaseContext> {
    return Effect.gen(function* () {
        yield* authorizeGraph(input.graphId);
        const result = yield* adapter.traceCalls({ ...input, direction: input.direction ?? "callees" });
        return makeToolResult("code_trace_calls", codeTraceCallsOutput.parse(result));
    }).pipe(Effect.mapError(toMcpCodeToolError));
}

export function registerMcpCodeTools(
    server: McpServer,
    authorizeGraph: McpCodeGraphAuthorizer,
    runEffect: McpEffectRunner
) {
    server.tool(
        "code_list_files",
        "List repository files from the fast code graph layers only.",
        codeListFilesInput,
        async (input) => runEffect(codeListFilesToolResult(authorizeGraph, codeListFilesInputObject.parse(input)))
    );

    server.tool(
        "code_search_symbols",
        "Search symbols from the fast code graph layers only.",
        codeSearchSymbolsInput,
        async (input) =>
            runEffect(codeSearchSymbolsToolResult(authorizeGraph, codeSearchSymbolsInputObject.parse(input)))
    );

    server.tool(
        "code_get_file_outline",
        "Return the symbol outline for one file from the fast code graph layers only.",
        codeGetFileOutlineInput,
        async (input) =>
            runEffect(codeGetFileOutlineToolResult(authorizeGraph, codeGetFileOutlineInputObject.parse(input)))
    );

    server.tool(
        "code_get_relationships",
        "Return code relationships from the fast code graph layers only.",
        codeGetRelationshipsInput,
        async (input) =>
            runEffect(codeGetRelationshipsToolResult(authorizeGraph, codeGetRelationshipsInputObject.parse(input)))
    );

    server.tool(
        "code_trace_calls",
        "Trace callers or callees from the fast code graph layers only.",
        codeTraceCallsInput,
        async (input) => runEffect(codeTraceCallsToolResult(authorizeGraph, codeTraceCallsInputObject.parse(input)))
    );
}
