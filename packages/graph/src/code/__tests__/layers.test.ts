import { describe, expect, test } from "bun:test";
import { buildCodeFileGraph, buildCodeRepositoryManifest, type CodeRepositoryFile } from "../repository";
import {
    buildCodeAstMinimalLayer,
    CODE_AST_MINIMAL_LAYER,
    KNOWLEDGE_REVIEW_RETRIEVAL_LAYER,
    type CodeGraphLayer,
} from "../layers";

const baseFile = (input: { fileId: string; path: string; content: string }): CodeRepositoryFile => ({
    fileId: input.fileId,
    repositoryUrl: "https://github.com/acme/widgets.git",
    repositoryName: "widgets",
    commitSha: "commit-1",
    path: input.path,
    content: input.content,
});

const helper = baseFile({
    fileId: "file-helper",
    path: "src/helper.ts",
    content: "export function helper() {\n  return 1;\n}\n",
});

const index = baseFile({
    fileId: "file-index",
    path: "src/index.ts",
    content: [
        "import { helper } from './helper';",
        "import * as z from 'zod';",
        "export class Runner {",
        "  run() {",
        "    return helper();",
        "  }",
        "}",
        "export const schema = z.object({ value: z.string() });",
    ].join("\n"),
});

const repositoryPrefix = "https://github.com/acme/widgets.git";

function edgeExists(layer: CodeGraphLayer, kind: string, sourceIncludes: string, targetIncludes: string) {
    return layer.edges.some(
        (edge) =>
            edge.kind === kind && edge.sourceKey.includes(sourceIncludes) && edge.targetKey.includes(targetIncludes)
    );
}

describe("code graph layers", () => {
    test("exposes stable layer constants", () => {
        expect(CODE_AST_MINIMAL_LAYER).toBe("code.ast.minimal.v1");
        expect(KNOWLEDGE_REVIEW_RETRIEVAL_LAYER).toBe("knowledge.review.retrieval.v1");
    });

    test("builds a serializable fast AST layer with deterministic file symbol and external facts", () => {
        const layer = buildCodeAstMinimalLayer([helper, index]);

        expect(layer.id).toEqual({
            graphId: expect.stringMatching(/^code_layer_/),
            layer: CODE_AST_MINIMAL_LAYER,
            repositoryScope: "https://github.com/acme/widgets.git",
            snapshotKey: "commit-1",
            branch: "default",
        });
        expect(JSON.parse(JSON.stringify(layer))).toEqual(layer);
        expect(buildCodeAstMinimalLayer([helper, index])).toEqual(layer);

        expect(layer.nodes).toContainEqual(
            expect.objectContaining({
                kind: "file",
                key: `${repositoryPrefix}:src/index.ts`,
                span: expect.objectContaining({
                    fileId: "file-index",
                    path: "src/index.ts",
                    startLine: 1,
                    endLine: 8,
                    startIndex: 0,
                    endIndex: index.content.length,
                }),
                properties: { entityType: "CODE_FILE" },
            })
        );
        expect(layer.nodes).toContainEqual(
            expect.objectContaining({
                kind: "symbol",
                key: `${repositoryPrefix}:src/index.ts#Runner`,
                properties: { entityType: "CODE_CLASS" },
            })
        );
        expect(layer.nodes).toContainEqual(
            expect.objectContaining({
                kind: "symbol",
                key: `${repositoryPrefix}:src/helper.ts#helper`,
                span: expect.objectContaining({
                    fileId: "file-helper",
                    path: "src/helper.ts",
                    startLine: 1,
                    endLine: 3,
                }),
                properties: { entityType: "CODE_FUNCTION" },
            })
        );
        expect(layer.nodes.some((node) => node.kind === "external" && node.key.includes("zod"))).toBe(true);

        expect(edgeExists(layer, "CONTAINS", "src/index.ts", "src/index.ts#Runner")).toBe(true);
        expect(edgeExists(layer, "IMPORTS", "src/index.ts", "src/helper.ts")).toBe(true);
        expect(edgeExists(layer, "IMPORTS", "src/index.ts", "external:zod")).toBe(true);
        expect(edgeExists(layer, "CALLS", "src/index.ts#Runner.run", "src/helper.ts#helper")).toBe(true);
        expect(edgeExists(layer, "CALLS", "src/index.ts", "external:zod#object")).toBe(true);
        expect(layer.edges.every((edge) => edge.directed === true)).toBe(true);
        expect(layer.edges.every((edge) => edge.properties && typeof edge.properties.strength === "number")).toBe(true);
    });

    test("uses repository branch in layer identity", () => {
        const layer = buildCodeAstMinimalLayer([
            { ...helper, branch: "feature/search", defaultBranch: "main" },
            { ...index, branch: "feature/search", defaultBranch: "main" },
        ]);

        expect(layer.id.branch).toBe("feature/search");
        expect(layer.id.snapshotKey).toBe("commit-1");
    });

    test("keeps current repository graph output independent from fast layer projection", () => {
        const manifest = buildCodeRepositoryManifest([helper, index]);
        const graphBefore = buildCodeFileGraph(index, manifest);

        buildCodeAstMinimalLayer([helper, index]);

        const graphAfter = buildCodeFileGraph(index, manifest);
        expect(graphAfter).toEqual(graphBefore);
    });
});
