import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    MCP_CODE_TOOL_NAMES,
    codeListFilesToolResult,
    registerMcpCodeTools,
    type McpCodeGraphAuthorizer,
    type McpEffectRunner,
} from "../code-tools";
import { unavailableFastCodeGraphReadAdapter } from "../../../lib/code/fast-layer-read";

const authorizeGraph: McpCodeGraphAuthorizer = () => Effect.void;
const runEffect: McpEffectRunner = (effect) =>
    Effect.runPromise(effect as Effect.Effect<unknown, never, never>) as Promise<never>;

describe("MCP code tools", () => {
    test("registers dedicated code tool names", () => {
        const registeredNames: string[] = [];
        const server = {
            tool: (name: string) => {
                registeredNames.push(name);
            },
        } as unknown as McpServer;

        registerMcpCodeTools(server, authorizeGraph, runEffect);

        expect(registeredNames.sort()).toEqual([...MCP_CODE_TOOL_NAMES].sort());
    });

    test("returns typed unavailable results from the fast-layer adapter seam", async () => {
        const result = (await Effect.runPromise(
            codeListFilesToolResult(
                authorizeGraph,
                { graphId: "graph-1" },
                unavailableFastCodeGraphReadAdapter
            ) as Effect.Effect<unknown, never, never>
        )) as { structuredContent: unknown; content: Array<{ text?: string }> };
        expect(result.structuredContent).toEqual({
            status: "unavailable",
            graphId: "graph-1",
            reason: "storage_not_configured",
            layerNames: ["code.ast.minimal.v1", "knowledge.review.retrieval.v1"],
            message:
                "Fast code graph storage is not available for this deployment yet. The code_* MCP tools read only fast code graph layers and do not fall back to the full graph.",
        });
        expect(result.content[0]?.text).toContain("code_list_files");
    });
    test("passes branch selectors to the fast-layer adapter", async () => {
        let observedBranch: string | undefined;
        const adapter = {
            ...unavailableFastCodeGraphReadAdapter,
            listFiles: (input: { graphId: string; branch?: string }) => {
                observedBranch = input.branch;
                return Effect.succeed({ status: "ok" as const, graphId: input.graphId, files: [] });
            },
        };

        await Effect.runPromise(
            codeListFilesToolResult(
                authorizeGraph,
                { graphId: "graph-1", branch: "feature/search" },
                adapter
            ) as Effect.Effect<unknown, never, never>
        );

        expect(observedBranch).toBe("feature/search");
    });
});
