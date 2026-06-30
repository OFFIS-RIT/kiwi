import { and, asc, eq, ilike, inArray, or } from "@kiwi/db/drizzle";
import { tryDb, type Database } from "@kiwi/db/effect";
import { codeGraphEdgesTable, codeGraphLayersTable, codeGraphNodesTable } from "@kiwi/db/tables/graph";
import * as Effect from "effect/Effect";

export const CODE_GRAPH_LAYER_NAMES = ["code.ast.minimal.v1", "knowledge.review.retrieval.v1"] as const;
export const FAST_CODE_GRAPH_LAYER = "code.ast.minimal.v1" as const;

export type CodeGraphLayerName = (typeof CODE_GRAPH_LAYER_NAMES)[number];

export type CodeToolUnavailable = {
    status: "unavailable";
    graphId: string;
    reason: "storage_not_configured" | "fast_code_graph_not_indexed";
    layerNames: CodeGraphLayerName[];
    message: string;
};

export type CodeFileSummary = {
    path: string;
    language?: string;
    repository?: string;
    symbolCount?: number;
};

export type CodeSymbolSearchResult = {
    id: string;
    name: string;
    kind: string;
    path: string;
    range?: CodeSourceRange;
};

export type CodeFileOutlineEntry = {
    id: string;
    name: string;
    kind: string;
    range?: CodeSourceRange;
    parentId?: string;
};

export type CodeRelationship = {
    id: string;
    type: string;
    fromId: string;
    toId: string;
    fromName?: string;
    toName?: string;
    path?: string;
};

export type CodeCallTraceStep = {
    fromId: string;
    toId: string;
    fromName?: string;
    toName?: string;
    path?: string;
};

export type CodeSourceRange = {
    startLine: number;
    endLine: number;
};

export type CodeListFilesInput = {
    graphId: string;
    branch?: string;
    pathPrefix?: string;
    query?: string;
    limit?: number;
};

export type CodeSearchSymbolsInput = {
    graphId: string;
    branch?: string;
    query: string;
    kind?: string;
    pathPrefix?: string;
    limit?: number;
};

export type CodeGetFileOutlineInput = {
    graphId: string;
    branch?: string;
    path: string;
};

export type CodeGetRelationshipsInput = {
    graphId: string;
    branch?: string;
    symbolId?: string;
    path?: string;
    relationshipType?: string;
    limit?: number;
};

export type CodeTraceCallsInput = {
    graphId: string;
    branch?: string;
    symbolId: string;
    direction?: "callers" | "callees";
    depth?: number;
    limit?: number;
};

export type CodeListFilesResult =
    | CodeToolUnavailable
    | {
          status: "ok";
          graphId: string;
          files: CodeFileSummary[];
      };

export type CodeSearchSymbolsResult =
    | CodeToolUnavailable
    | {
          status: "ok";
          graphId: string;
          symbols: CodeSymbolSearchResult[];
      };

export type CodeGetFileOutlineResult =
    | CodeToolUnavailable
    | {
          status: "ok";
          graphId: string;
          path: string;
          outline: CodeFileOutlineEntry[];
      };

export type CodeGetRelationshipsResult =
    | CodeToolUnavailable
    | {
          status: "ok";
          graphId: string;
          relationships: CodeRelationship[];
      };

export type CodeTraceCallsResult =
    | CodeToolUnavailable
    | {
          status: "ok";
          graphId: string;
          symbolId: string;
          direction: "callers" | "callees";
          steps: CodeCallTraceStep[];
      };

export type FastCodeGraphReadAdapter = {
    listFiles(input: CodeListFilesInput): Effect.Effect<CodeListFilesResult, unknown, Database>;
    searchSymbols(input: CodeSearchSymbolsInput): Effect.Effect<CodeSearchSymbolsResult, unknown, Database>;
    getFileOutline(input: CodeGetFileOutlineInput): Effect.Effect<CodeGetFileOutlineResult, unknown, Database>;
    getRelationships(input: CodeGetRelationshipsInput): Effect.Effect<CodeGetRelationshipsResult, unknown, Database>;
    traceCalls(input: CodeTraceCallsInput): Effect.Effect<CodeTraceCallsResult, unknown, Database>;
};

const storageUnavailableMessage =
    "Fast code graph storage is not available for this deployment yet. The code_* MCP tools read only fast code graph layers and do not fall back to the full graph.";

const notIndexedMessage =
    "No current fast code graph layer is indexed for this graph. Re-index code files to create code.ast.minimal.v1.";

function unavailable(graphId: string, reason: CodeToolUnavailable["reason"]): CodeToolUnavailable {
    return {
        status: "unavailable",
        graphId,
        reason,
        layerNames: [...CODE_GRAPH_LAYER_NAMES],
        message: reason === "storage_not_configured" ? storageUnavailableMessage : notIndexedMessage,
    };
}

function range(row: { startLine: number | null; endLine: number | null }): CodeSourceRange | undefined {
    return row.startLine !== null && row.endLine !== null
        ? { startLine: row.startLine, endLine: row.endLine }
        : undefined;
}

function stringProperty(properties: unknown, key: string): string | undefined {
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
        return undefined;
    }
    const value = (properties as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
}

function normalizedLimit(limit: number | undefined, fallback = 50) {
    return Math.max(1, Math.min(limit ?? fallback, 100));
}

function currentLayerIds(graphId: string, branch?: string): Effect.Effect<string[], unknown, Database> {
    return Effect.map(
        tryDb((db) =>
            db
                .select({
                    id: codeGraphLayersTable.id,
                    branch: codeGraphLayersTable.branch,
                    metadata: codeGraphLayersTable.metadata,
                })
                .from(codeGraphLayersTable)
                .where(
                    and(
                        eq(codeGraphLayersTable.graphId, graphId),
                        eq(codeGraphLayersTable.layer, FAST_CODE_GRAPH_LAYER),
                        branch ? eq(codeGraphLayersTable.branch, branch) : undefined,
                        eq(codeGraphLayersTable.status, "current")
                    )
                )
        ),
        (rows) => {
            if (branch) {
                return rows.map((row) => row.id);
            }
            const defaultRows = rows.filter((row) => isDefaultLayerMetadata(row.metadata));
            if (defaultRows.length > 0) {
                return defaultRows.map((row) => row.id);
            }
            const legacyDefaultRows = rows.filter((row) => row.branch === "default");
            return (legacyDefaultRows.length > 0 ? legacyDefaultRows : rows).map((row) => row.id);
        }
    );
}

function isDefaultLayerMetadata(metadata: unknown): boolean {
    return (
        typeof metadata === "object" &&
        metadata !== null &&
        !Array.isArray(metadata) &&
        (metadata as { isDefaultBranch?: unknown }).isDefaultBranch === true
    );
}

function withCurrentLayers<T>(
    graphId: string,
    branch: string | undefined,
    run: (layerIds: string[]) => Effect.Effect<T, unknown, Database>
): Effect.Effect<T | CodeToolUnavailable, unknown, Database> {
    return Effect.gen(function* () {
        const layerIds = yield* currentLayerIds(graphId, branch);
        if (layerIds.length === 0) {
            return unavailable(graphId, "fast_code_graph_not_indexed");
        }
        return yield* run(layerIds);
    });
}

export const databaseFastCodeGraphReadAdapter: FastCodeGraphReadAdapter = {
    listFiles: (input) =>
        withCurrentLayers(input.graphId, input.branch, (layerIds) =>
            Effect.map(
                tryDb((db) =>
                    db
                        .select({
                            path: codeGraphNodesTable.path,
                            name: codeGraphNodesTable.name,
                            properties: codeGraphNodesTable.properties,
                        })
                        .from(codeGraphNodesTable)
                        .where(
                            and(
                                inArray(codeGraphNodesTable.layerId, layerIds),
                                eq(codeGraphNodesTable.nodeKind, "file"),
                                input.pathPrefix ? ilike(codeGraphNodesTable.path, `${input.pathPrefix}%`) : undefined,
                                input.query ? ilike(codeGraphNodesTable.path, `%${input.query}%`) : undefined
                            )
                        )
                        .orderBy(asc(codeGraphNodesTable.path), asc(codeGraphNodesTable.name))
                        .limit(normalizedLimit(input.limit))
                ),
                (rows): CodeListFilesResult => ({
                    status: "ok",
                    graphId: input.graphId,
                    files: rows.map((row) => ({
                        path: row.path ?? row.name,
                        language: stringProperty(row.properties, "language"),
                        repository: stringProperty(row.properties, "repository"),
                    })),
                })
            )
        ),

    searchSymbols: (input) =>
        withCurrentLayers(input.graphId, input.branch, (layerIds) =>
            Effect.map(
                tryDb((db) =>
                    db
                        .select({
                            nodeKey: codeGraphNodesTable.nodeKey,
                            name: codeGraphNodesTable.name,
                            nodeKind: codeGraphNodesTable.nodeKind,
                            path: codeGraphNodesTable.path,
                            startLine: codeGraphNodesTable.startLine,
                            endLine: codeGraphNodesTable.endLine,
                            properties: codeGraphNodesTable.properties,
                        })
                        .from(codeGraphNodesTable)
                        .where(
                            and(
                                inArray(codeGraphNodesTable.layerId, layerIds),
                                eq(codeGraphNodesTable.nodeKind, "symbol"),
                                ilike(codeGraphNodesTable.name, `%${input.query}%`),
                                input.pathPrefix ? ilike(codeGraphNodesTable.path, `${input.pathPrefix}%`) : undefined
                            )
                        )
                        .orderBy(asc(codeGraphNodesTable.name), asc(codeGraphNodesTable.path))
                        .limit(normalizedLimit(input.limit))
                ),
                (rows): CodeSearchSymbolsResult => {
                    const symbols = rows.map((row) => ({
                        id: row.nodeKey,
                        name: row.name,
                        kind: stringProperty(row.properties, "entityType") ?? row.nodeKind,
                        path: row.path ?? "",
                        range: range(row),
                    }));
                    return {
                        status: "ok",
                        graphId: input.graphId,
                        symbols: input.kind
                            ? symbols.filter((symbol) => symbol.kind.toLowerCase().includes(input.kind!.toLowerCase()))
                            : symbols,
                    };
                }
            )
        ),

    getFileOutline: (input) =>
        withCurrentLayers(input.graphId, input.branch, (layerIds) =>
            Effect.map(
                tryDb((db) =>
                    db
                        .select({
                            nodeKey: codeGraphNodesTable.nodeKey,
                            name: codeGraphNodesTable.name,
                            nodeKind: codeGraphNodesTable.nodeKind,
                            startLine: codeGraphNodesTable.startLine,
                            endLine: codeGraphNodesTable.endLine,
                            properties: codeGraphNodesTable.properties,
                        })
                        .from(codeGraphNodesTable)
                        .where(
                            and(
                                inArray(codeGraphNodesTable.layerId, layerIds),
                                eq(codeGraphNodesTable.nodeKind, "symbol"),
                                eq(codeGraphNodesTable.path, input.path)
                            )
                        )
                        .orderBy(asc(codeGraphNodesTable.startLine), asc(codeGraphNodesTable.name))
                        .limit(100)
                ),
                (rows): CodeGetFileOutlineResult => ({
                    status: "ok",
                    graphId: input.graphId,
                    path: input.path,
                    outline: rows.map((row) => ({
                        id: row.nodeKey,
                        name: row.name,
                        kind: stringProperty(row.properties, "entityType") ?? row.nodeKind,
                        range: range(row),
                    })),
                })
            )
        ),

    getRelationships: (input) =>
        withCurrentLayers(input.graphId, input.branch, (layerIds) =>
            Effect.map(
                tryDb((db) =>
                    db
                        .select({
                            edgeKey: codeGraphEdgesTable.edgeKey,
                            sourceKey: codeGraphEdgesTable.sourceKey,
                            targetKey: codeGraphEdgesTable.targetKey,
                            edgeKind: codeGraphEdgesTable.edgeKind,
                            path: codeGraphEdgesTable.path,
                        })
                        .from(codeGraphEdgesTable)
                        .where(
                            and(
                                inArray(codeGraphEdgesTable.layerId, layerIds),
                                input.symbolId
                                    ? or(
                                          eq(codeGraphEdgesTable.sourceKey, input.symbolId),
                                          eq(codeGraphEdgesTable.targetKey, input.symbolId)
                                      )
                                    : undefined,
                                input.path ? eq(codeGraphEdgesTable.path, input.path) : undefined,
                                input.relationshipType
                                    ? eq(codeGraphEdgesTable.edgeKind, input.relationshipType)
                                    : undefined
                            )
                        )
                        .orderBy(asc(codeGraphEdgesTable.edgeKind), asc(codeGraphEdgesTable.sourceKey))
                        .limit(normalizedLimit(input.limit))
                ),
                (rows): CodeGetRelationshipsResult => ({
                    status: "ok",
                    graphId: input.graphId,
                    relationships: rows.map((row) => ({
                        id: row.edgeKey,
                        type: row.edgeKind,
                        fromId: row.sourceKey,
                        toId: row.targetKey,
                        fromName: row.sourceKey,
                        toName: row.targetKey,
                        path: row.path ?? undefined,
                    })),
                })
            )
        ),

    traceCalls: (input) =>
        withCurrentLayers(input.graphId, input.branch, (layerIds) =>
            Effect.gen(function* () {
                const direction = input.direction ?? "callees";
                const maxDepth = Math.max(1, Math.min(input.depth ?? 2, 5));
                const maxSteps = normalizedLimit(input.limit, 50);
                const seen = new Set<string>();
                const steps: CodeCallTraceStep[] = [];
                let frontier = [input.symbolId];

                for (let depth = 0; depth < maxDepth && frontier.length > 0 && steps.length < maxSteps; depth += 1) {
                    const current = frontier;
                    frontier = [];
                    const rows = yield* tryDb((db) =>
                        db
                            .select({
                                sourceKey: codeGraphEdgesTable.sourceKey,
                                targetKey: codeGraphEdgesTable.targetKey,
                                path: codeGraphEdgesTable.path,
                            })
                            .from(codeGraphEdgesTable)
                            .where(
                                and(
                                    inArray(codeGraphEdgesTable.layerId, layerIds),
                                    eq(codeGraphEdgesTable.edgeKind, "CALLS"),
                                    direction === "callees"
                                        ? inArray(codeGraphEdgesTable.sourceKey, current)
                                        : inArray(codeGraphEdgesTable.targetKey, current)
                                )
                            )
                            .orderBy(asc(codeGraphEdgesTable.sourceKey), asc(codeGraphEdgesTable.targetKey))
                            .limit(maxSteps)
                    );

                    for (const row of rows) {
                        const key = `${row.sourceKey}\0${row.targetKey}`;
                        if (seen.has(key)) {
                            continue;
                        }
                        seen.add(key);
                        steps.push({
                            fromId: row.sourceKey,
                            toId: row.targetKey,
                            fromName: row.sourceKey,
                            toName: row.targetKey,
                            path: row.path ?? undefined,
                        });
                        frontier.push(direction === "callees" ? row.targetKey : row.sourceKey);
                        if (steps.length >= maxSteps) {
                            break;
                        }
                    }
                }

                return {
                    status: "ok",
                    graphId: input.graphId,
                    symbolId: input.symbolId,
                    direction,
                    steps,
                } satisfies CodeTraceCallsResult;
            })
        ),
};

export const unavailableFastCodeGraphReadAdapter: FastCodeGraphReadAdapter = {
    listFiles: (input) => Effect.succeed(unavailable(input.graphId, "storage_not_configured")),
    searchSymbols: (input) => Effect.succeed(unavailable(input.graphId, "storage_not_configured")),
    getFileOutline: (input) => Effect.succeed(unavailable(input.graphId, "storage_not_configured")),
    getRelationships: (input) => Effect.succeed(unavailable(input.graphId, "storage_not_configured")),
    traceCalls: (input) => Effect.succeed(unavailable(input.graphId, "storage_not_configured")),
};

export function getFastCodeGraphReadAdapter(): FastCodeGraphReadAdapter {
    return databaseFastCodeGraphReadAdapter;
}
