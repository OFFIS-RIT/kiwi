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

export type { CorrectionToolContext } from "./correction";

export type GraphToolsetOptions = {
    graphId: string;
    embeddingModel: EmbeddingModelV3;
    correction?: CorrectionToolContext;
    onConsideredFileIds?: (fileIds: Iterable<string>) => void;
};

export function buildGraphExplorationToolset({ graphId, embeddingModel, onConsideredFileIds }: GraphToolsetOptions) {
    return {
        list_files: listFilesTool(graphId, { onConsideredFileIds }),
        search_entities: searchEntityTool(graphId, embeddingModel, { onConsideredFileIds }),
        list_entities: listEntitiesTool(graphId, { onConsideredFileIds }),
        search_relationships: searchRelationshipsTool(graphId, embeddingModel, { onConsideredFileIds }),
        get_relationships: getRelationshipsTool(graphId),
        get_entity_neighbours: getNeighboursTool(graphId),
        get_path_between_entities: getPathBetweenTool(graphId),
    } satisfies ToolSet;
}

export function buildSourceGroundingToolset({ graphId, embeddingModel, onConsideredFileIds }: GraphToolsetOptions) {
    return {
        get_entity_sources: getEntitySourcesTool(graphId, embeddingModel, { onConsideredFileIds }),
        get_relationship_sources: getRelationshipSourcesTool(graphId, embeddingModel, { onConsideredFileIds }),
        similar_sources_check: similarSourcesCheckTool(graphId, { onConsideredFileIds }),
    } satisfies ToolSet;
}

export function buildSourceCurationToolset(options: GraphToolsetOptions) {
    return {
        ...buildSourceGroundingToolset(options),
        get_source_file_metadata: getSourceFileMetadataTool(options.graphId, {
            onConsideredFileIds: options.onConsideredFileIds,
        }),
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
    return buildServerToolset(options);
}
