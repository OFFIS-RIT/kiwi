import type { Entity, Graph, Relationship, Unit } from "..";
import { buildCodeFileGraph, buildCodeRepositoryManifest } from "./repository";
import type { CodeRepositoryFile } from "./types";
import { stableId } from "./identity";

export const CODE_AST_MINIMAL_LAYER = "code.ast.minimal.v1";
export const KNOWLEDGE_REVIEW_RETRIEVAL_LAYER = "knowledge.review.retrieval.v1";

export type CodeGraphLayerName = typeof CODE_AST_MINIMAL_LAYER | typeof KNOWLEDGE_REVIEW_RETRIEVAL_LAYER;

export type CodeGraphLayerId = {
    graphId: string;
    layer: CodeGraphLayerName;
    repositoryScope: string;
    branch: string;
    snapshotKey: string;
};

export type CodeSpan = {
    fileId: string;
    path: string;
    startLine: number;
    endLine: number;
    startIndex: number;
    endIndex: number;
};

export type CodeLayerNodeKind = "file" | "module" | "symbol" | "external";

export type CodeLayerNode = {
    id: string;
    key: string;
    kind: CodeLayerNodeKind;
    name: string;
    span?: CodeSpan;
    properties?: Record<string, unknown>;
};

export type CodeLayerEdgeKind = "CONTAINS" | "IMPORTS" | "CALLS" | "EXTENDS" | "IMPLEMENTS" | "RELATED";

export type CodeLayerEdge = {
    id: string;
    sourceKey: string;
    targetKey: string;
    kind: CodeLayerEdgeKind;
    directed: true;
    span?: CodeSpan;
    properties?: Record<string, unknown>;
};

export type CodeGraphLayer = {
    id: CodeGraphLayerId;
    nodes: CodeLayerNode[];
    edges: CodeLayerEdge[];
    graph?: Graph;
};

export type BuildCodeAstMinimalLayerOptions = {
    graphId?: string;
    repositoryScope?: string;
    snapshotKey?: string;
    branch?: string;
};

export function buildCodeAstMinimalLayer(
    files: CodeRepositoryFile[],
    options: BuildCodeAstMinimalLayerOptions = {}
): CodeGraphLayer {
    const manifest = buildCodeRepositoryManifest(files);
    const graphs = files.map((file) => buildCodeFileGraph(file, manifest));
    const graph = combineCodeGraphs(graphs);
    const filesById = new Map(files.map((file) => [file.fileId, file]));
    const filePathsByEntityId = new Map(manifest.files.map((file) => [file.entityId, file.path]));
    const unitsById = new Map(graph.units.map((unit) => [unit.id, unit]));
    const entitiesById = new Map(graph.entities.map((entity) => [entity.id, entity]));
    const repositoryUrls = files.map((file) => file.repositoryUrl);
    const commitShas = files.map((file) => file.commitSha);
    const branches = files.map((file) => file.branch).filter((branch): branch is string => branch !== undefined);
    const repositoryScope =
        options.repositoryScope ?? commonValue(repositoryUrls) ?? stableScope("code_repository_scope", repositoryUrls);
    const branch = options.branch ?? commonValue(branches) ?? "default";
    const snapshotKey = options.snapshotKey ?? commonValue(commitShas) ?? stableScope("code_snapshot", commitShas);

    const nodes = graph.entities
        .map((entity) => codeLayerNode(entity, unitsById, filesById, filePathsByEntityId.get(entity.id)))
        .sort(compareNodes);
    const edges = graph.relationships
        .map((relationship) => codeLayerEdge(relationship, entitiesById, unitsById, filesById))
        .filter((edge): edge is CodeLayerEdge => edge !== null)
        .sort(compareEdges);

    return {
        id: {
            graphId:
                options.graphId ??
                stableId(
                    "code_layer",
                    CODE_AST_MINIMAL_LAYER,
                    repositoryScope,
                    snapshotKey,
                    branch,
                    ...files.map((file) => `${file.path}:${file.fileId}`).sort()
                ),
            layer: CODE_AST_MINIMAL_LAYER,
            repositoryScope,
            branch,
            snapshotKey,
        },
        nodes,
        edges,
    };
}

function combineCodeGraphs(graphs: Graph[]): Graph {
    const unitsById = new Map<string, Unit>();
    const entitiesById = new Map<string, Entity>();
    const relationshipsById = new Map<string, Relationship>();

    for (const graph of graphs) {
        for (const unit of graph.units) {
            unitsById.set(unit.id, unit);
        }

        for (const entity of graph.entities) {
            const existing = entitiesById.get(entity.id);
            if (existing) {
                existing.sources = mergeSources(existing.sources, entity.sources);
                continue;
            }
            entitiesById.set(entity.id, { ...entity, sources: [...entity.sources] });
        }

        for (const relationship of graph.relationships) {
            const existing = relationshipsById.get(relationship.id);
            if (existing) {
                existing.sources = mergeSources(existing.sources, relationship.sources);
                existing.strength = Math.max(existing.strength, relationship.strength);
                continue;
            }
            relationshipsById.set(relationship.id, { ...relationship, sources: [...relationship.sources] });
        }
    }

    return {
        id: stableId("code_graph", ...graphs.map((graph) => graph.id).sort()),
        units: [...unitsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
        entities: [...entitiesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
        relationships: [...relationshipsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
}

function mergeSources<T extends { id: string }>(left: T[], right: T[]): T[] {
    const byId = new Map(left.map((source) => [source.id, source]));
    for (const source of right) {
        byId.set(source.id, source);
    }
    return [...byId.values()].sort((leftSource, rightSource) => leftSource.id.localeCompare(rightSource.id));
}

function codeLayerNode(
    entity: Entity,
    unitsById: ReadonlyMap<string, Unit>,
    filesById: ReadonlyMap<string, CodeRepositoryFile>,
    filePath?: string
): CodeLayerNode {
    return stripUndefined({
        id: entity.id,
        key: entity.name,
        kind: nodeKind(entity.type),
        name: entity.name,
        span: spanForSources(entity.sources, unitsById, filesById) ?? spanForFilePath(filePath, filesById),
        properties: {
            entityType: entity.type,
        },
    });
}

function codeLayerEdge(
    relationship: Relationship,
    entitiesById: ReadonlyMap<string, Entity>,
    unitsById: ReadonlyMap<string, Unit>,
    filesById: ReadonlyMap<string, CodeRepositoryFile>
): CodeLayerEdge | null {
    const source = entitiesById.get(relationship.sourceId);
    const target = entitiesById.get(relationship.targetId);
    if (!source || !target) {
        return null;
    }

    return stripUndefined({
        id: relationship.id,
        sourceKey: source.name,
        targetKey: target.name,
        kind: edgeKind(relationship.kind),
        directed: true as const,
        span: spanForSources(relationship.sources, unitsById, filesById),
        properties: {
            strength: relationship.strength,
            relationshipKind: relationship.kind ?? "RELATED",
        },
    });
}

function nodeKind(entityType: string): CodeLayerNodeKind {
    if (entityType === "CODE_FILE") {
        return "file";
    }
    if (entityType.startsWith("CODE_EXTERNAL")) {
        return "external";
    }
    return "symbol";
}

function edgeKind(kind: string | undefined): CodeLayerEdgeKind {
    switch (kind) {
        case "CONTAINS":
        case "IMPORTS":
        case "CALLS":
        case "EXTENDS":
        case "IMPLEMENTS":
            return kind;
        default:
            return "RELATED";
    }
}

function spanForSources(
    sources: Entity["sources"],
    unitsById: ReadonlyMap<string, Unit>,
    filesById: ReadonlyMap<string, CodeRepositoryFile>
): CodeSpan | undefined {
    for (const source of sources) {
        const unit = unitsById.get(source.unitId);
        if (!unit) {
            continue;
        }
        const chunkId = source.sourceChunkIds?.[0];
        const chunk =
            chunkId === undefined ? unit.chunks[0] : unit.chunks.find((candidate) => candidate.id === chunkId);
        if (!chunk || chunk.type !== "text") {
            continue;
        }
        const file = filesById.get(unit.fileId);
        if (!file) {
            continue;
        }
        if (chunk.startLine !== undefined && chunk.endLine !== undefined) {
            return {
                fileId: unit.fileId,
                path: chunk.filePath ?? file.path,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                startIndex: offsetForLineColumn(file.content, chunk.startLine, chunk.startColumn ?? 1),
                endIndex: offsetForLineColumn(file.content, chunk.endLine, chunk.endColumn ?? 1),
            };
        }
        return spanForFile(file);
    }

    return undefined;
}

function spanForFilePath(
    filePath: string | undefined,
    filesById: ReadonlyMap<string, CodeRepositoryFile>
): CodeSpan | undefined {
    if (!filePath) {
        return undefined;
    }
    for (const file of filesById.values()) {
        if (file.path === filePath) {
            return spanForFile(file);
        }
    }
    return undefined;
}

function spanForFile(file: CodeRepositoryFile): CodeSpan {
    return {
        fileId: file.fileId,
        path: file.path,
        startLine: 1,
        endLine: Math.max(1, file.content.split("\n").length),
        startIndex: 0,
        endIndex: file.content.length,
    };
}

function offsetForLineColumn(content: string, line: number, column: number): number {
    const lineStarts = [0];
    for (let index = 0; index < content.length; index += 1) {
        if (content[index] === "\n") {
            lineStarts.push(index + 1);
        }
    }
    const lineStart = lineStarts[Math.max(0, line - 1)] ?? content.length;
    return Math.max(0, Math.min(content.length, lineStart + Math.max(0, column - 1)));
}

function commonValue(values: string[]): string | null {
    const uniqueValues = [...new Set(values.filter((value) => value.length > 0))];
    return uniqueValues.length === 1 ? uniqueValues[0]! : null;
}

function stableScope(prefix: string, values: string[]): string {
    const uniqueValues = [...new Set(values.filter((value) => value.length > 0))].sort();
    if (uniqueValues.length === 0) {
        return "empty";
    }
    return stableId(prefix, ...uniqueValues);
}

function compareNodes(left: CodeLayerNode, right: CodeLayerNode): number {
    return left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key) || left.id.localeCompare(right.id);
}

function compareEdges(left: CodeLayerEdge, right: CodeLayerEdge): number {
    return (
        left.kind.localeCompare(right.kind) ||
        left.sourceKey.localeCompare(right.sourceKey) ||
        left.targetKey.localeCompare(right.targetKey) ||
        left.id.localeCompare(right.id)
    );
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
