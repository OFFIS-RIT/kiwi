import { CODE_AST_MINIMAL_LAYER, buildCodeAstMinimalLayer } from "@kiwi/graph/code/layers";
import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import type { FileStorage } from "@kiwi/files";
import { loadCodeRepositoryContext, type CodeRepositoryContext } from "./manifest";
import { saveFastCodeGraphLayer, type SaveFastCodeGraphLayerResult } from "./fast-layer-store";

export type BuildAndSaveFastCodeGraphLayerResult = SaveFastCodeGraphLayerResult & {
    repositoryScope: string;
    snapshotKey: string;
    branch: string;
};

export function buildAndSaveFastCodeGraphLayer(options: {
    graphId: string;
    fileIds: string[];
    processRunId?: string;
}): Effect.Effect<BuildAndSaveFastCodeGraphLayerResult | undefined, unknown, Database | FileStorage> {
    return Effect.gen(function* () {
        const context = yield* loadCodeRepositoryContext({ graphId: options.graphId, fileIds: options.fileIds });
        if (!context) {
            return undefined;
        }

        return yield* buildAndSaveFastCodeGraphLayerFromContext(context, options);
    });
}

export function buildAndSaveFastCodeGraphLayerFromContext(
    context: CodeRepositoryContext,
    options: {
        graphId: string;
        processRunId?: string;
    }
): Effect.Effect<BuildAndSaveFastCodeGraphLayerResult, unknown, Database> {
    return Effect.gen(function* () {
        const repositoryScope = codeRepositoryScopeKey(options.graphId, context.repositoryScopes);
        const branch = context.branch;
        const snapshotKey = codeRepositorySnapshotKey(context.files);
        const layer = buildCodeAstMinimalLayer(context.files, {
            graphId: options.graphId,
            repositoryScope,
            branch,
            snapshotKey,
        });
        const saved = yield* saveFastCodeGraphLayer(layer, {
            processRunId: options.processRunId,
            fileCount: context.files.length,
            checksum: `${CODE_AST_MINIMAL_LAYER}:${branch}:${snapshotKey}`,
            branch,
            ...(context.defaultBranch ? { defaultBranch: context.defaultBranch } : {}),
            isDefaultBranch: context.isDefaultBranch,
        });

        return {
            ...saved,
            repositoryScope,
            snapshotKey,
            branch,
        };
    });
}

function codeRepositoryScopeKey(graphId: string, repositoryScopes: string[]) {
    if (repositoryScopes.length === 1) {
        return repositoryScopes[0]!;
    }

    if (repositoryScopes.length === 0) {
        return `graph:${graphId}`;
    }

    return `selection:${repositoryScopes.join("\0")}`;
}

function codeRepositorySnapshotKey(files: Array<{ fileId: string; commitSha: string; path: string }>) {
    return files
        .map((file) => `${file.commitSha}\0${file.path}\0${file.fileId}`)
        .sort()
        .join("\n");
}
