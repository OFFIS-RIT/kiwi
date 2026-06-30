import type { EmbeddingModelV3 } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import { correctionTool, type CorrectionToolContext } from "./correction";
import { listEntitiesTool, searchEntityTool } from "./entity";
import { listFilesTool } from "./file";
import { getNeighboursTool, getPathBetweenTool, getRelationshipsTool, searchRelationshipsTool } from "./relationship";
import {
    getEntitySourcesTool,
    getRelationshipSourcesTool,
    getSourceFileMetadataTool,
    similarSourcesCheckTool,
} from "./source";
import { askQuestionTool } from "./user";
import { normalizeGraphContentScope, type GraphContentScope } from "./content-scope";

export type { GraphContentScope } from "./content-scope";
export type { CorrectionToolContext } from "./correction";

export type GraphToolsetOptions = {
    graphId: string;
    embeddingModel: EmbeddingModelV3;
    correction?: CorrectionToolContext;
    contentScope?: GraphContentScope;
    onConsideredFileIds?: (fileIds: Iterable<string>) => void;
};

export function buildGraphExplorationToolset({
    graphId,
    embeddingModel,
    contentScope,
    onConsideredFileIds,
}: GraphToolsetOptions) {
    const scope = normalizeGraphContentScope(contentScope);
    return {
        list_files: listFilesTool(graphId, { contentScope: scope, onConsideredFileIds }),
        search_entities: searchEntityTool(graphId, embeddingModel, { contentScope: scope, onConsideredFileIds }),
        list_entities: listEntitiesTool(graphId, { contentScope: scope, onConsideredFileIds }),
        search_relationships: searchRelationshipsTool(graphId, embeddingModel, {
            contentScope: scope,
            onConsideredFileIds,
        }),
        get_relationships: getRelationshipsTool(graphId, { contentScope: scope }),
        get_entity_neighbours: getNeighboursTool(graphId, { contentScope: scope }),
        get_path_between_entities: getPathBetweenTool(graphId, { contentScope: scope }),
    } satisfies ToolSet;
}

export function buildSourceGroundingToolset({
    graphId,
    embeddingModel,
    contentScope,
    onConsideredFileIds,
}: GraphToolsetOptions) {
    const scope = normalizeGraphContentScope(contentScope);
    return {
        get_entity_sources: getEntitySourcesTool(graphId, embeddingModel, { contentScope: scope, onConsideredFileIds }),
        get_relationship_sources: getRelationshipSourcesTool(graphId, embeddingModel, {
            contentScope: scope,
            onConsideredFileIds,
        }),
        similar_sources_check: similarSourcesCheckTool(graphId, { contentScope: scope, onConsideredFileIds }),
    } satisfies ToolSet;
}

export function buildSourceCurationToolset(options: GraphToolsetOptions) {
    const scope = normalizeGraphContentScope(options.contentScope);
    return {
        ...buildSourceGroundingToolset({ ...options, contentScope: scope }),
        get_source_file_metadata: getSourceFileMetadataTool(options.graphId, {
            contentScope: scope,
            onConsideredFileIds: options.onConsideredFileIds,
        }),
    } satisfies ToolSet;
}

export function buildCodeSearchToolset(options: GraphToolsetOptions) {
    return {
        ...buildGraphExplorationToolset({ ...options, contentScope: "code" }),
        ...buildSourceCurationToolset({ ...options, contentScope: "code" }),
    } satisfies ToolSet;
}

export function buildServerToolset(options: GraphToolsetOptions) {
    return {
        ...buildGraphExplorationToolset(options),
        ...buildSourceGroundingToolset(options),
        ...(options.correction ? { correction: correctionTool(options.correction) } : {}),
    } satisfies ToolSet;
}

export function buildServerAndClientToolset(options: GraphToolsetOptions) {
    return {
        ...buildServerToolset(options),
        ask_clarifying_questions: askQuestionTool(),
    } satisfies ToolSet;
}

export function buildDeepResearchToolset(subagentToolset: ToolSet) {
    return {
        ...subagentToolset,
    } satisfies ToolSet;
}

export function buildMcpResearchToolset(options: GraphToolsetOptions) {
    return buildServerToolset({ ...options, contentScope: "documents", correction: undefined });
}
