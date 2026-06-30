import { and, eq, sql } from "@kiwi/db/drizzle";
import {
    codeGraphEdgesTable,
    codeGraphLayersTable,
    codeGraphNodesTable,
    type CodeGraphEdgeProperties,
    type CodeGraphLayerMetadata,
    type CodeGraphNodeProperties,
} from "@kiwi/db/tables/graph";
import type { CodeGraphLayer } from "@kiwi/graph/code/layers";
import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import { withWorkerDb } from "../runtime/effect";

export type SaveFastCodeGraphLayerResult = {
    layerId: string;
    nodes: number;
    edges: number;
};

export function saveFastCodeGraphLayer(
    layer: CodeGraphLayer,
    metadata: CodeGraphLayerMetadata = {}
): Effect.Effect<SaveFastCodeGraphLayerResult, unknown, Database> {
    return withWorkerDb((db) =>
        db.transaction((tx) =>
            Effect.gen(function* () {
                yield* tx
                    .update(codeGraphLayersTable)
                    .set({ status: "replaced", replacedAt: sql`NOW()` })
                    .where(
                        and(
                            eq(codeGraphLayersTable.graphId, layer.id.graphId),
                            eq(codeGraphLayersTable.layer, layer.id.layer),
                            eq(codeGraphLayersTable.repositoryScope, layer.id.repositoryScope),
                            eq(codeGraphLayersTable.branch, layer.id.branch),
                            eq(codeGraphLayersTable.status, "current")
                        )
                    );

                yield* tx
                    .delete(codeGraphLayersTable)
                    .where(
                        and(
                            eq(codeGraphLayersTable.graphId, layer.id.graphId),
                            eq(codeGraphLayersTable.layer, layer.id.layer),
                            eq(codeGraphLayersTable.repositoryScope, layer.id.repositoryScope),
                            eq(codeGraphLayersTable.branch, layer.id.branch),
                            eq(codeGraphLayersTable.snapshotKey, layer.id.snapshotKey)
                        )
                    );

                const [insertedLayer] = yield* tx
                    .insert(codeGraphLayersTable)
                    .values({
                        graphId: layer.id.graphId,
                        layer: layer.id.layer,
                        repositoryScope: layer.id.repositoryScope,
                        branch: layer.id.branch,
                        snapshotKey: layer.id.snapshotKey,
                        nodeCount: layer.nodes.length,
                        edgeCount: layer.edges.length,
                        metadata,
                    })
                    .returning({ id: codeGraphLayersTable.id });

                if (!insertedLayer) {
                    return yield* Effect.fail(new Error("Failed to insert fast code graph layer"));
                }

                if (layer.nodes.length > 0) {
                    yield* tx.insert(codeGraphNodesTable).values(
                        layer.nodes.map((node) => ({
                            layerId: insertedLayer.id,
                            nodeKey: node.key,
                            nodeKind: node.kind,
                            name: node.name,
                            fileId: node.span?.fileId ?? null,
                            path: node.span?.path ?? null,
                            startLine: node.span?.startLine ?? null,
                            endLine: node.span?.endLine ?? null,
                            startIndex: node.span?.startIndex ?? null,
                            endIndex: node.span?.endIndex ?? null,
                            properties: (node.properties ?? {}) as CodeGraphNodeProperties,
                        }))
                    );
                }

                if (layer.edges.length > 0) {
                    yield* tx.insert(codeGraphEdgesTable).values(
                        layer.edges.map((edge) => ({
                            layerId: insertedLayer.id,
                            edgeKey: edge.id,
                            sourceKey: edge.sourceKey,
                            targetKey: edge.targetKey,
                            edgeKind: edge.kind,
                            fileId: edge.span?.fileId ?? null,
                            path: edge.span?.path ?? null,
                            startLine: edge.span?.startLine ?? null,
                            endLine: edge.span?.endLine ?? null,
                            startIndex: edge.span?.startIndex ?? null,
                            endIndex: edge.span?.endIndex ?? null,
                            properties: (edge.properties ?? {}) as CodeGraphEdgeProperties,
                        }))
                    );
                }

                return {
                    layerId: insertedLayer.id,
                    nodes: layer.nodes.length,
                    edges: layer.edges.length,
                };
            })
        )
    );
}
