import type { EmbeddingModelV3 } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import { listEntitiesTool, searchEntityTool } from "./entity";
import { listFilesTool } from "./file";
import { getNeighboursTool, getPathBetweenTool, getRelationshipsTool, searchRelationshipsTool } from "./relationship";
import { getEntitySourcesTool, getRelationshipSourcesTool, getSourceFileMetadataTool } from "./source";
import { askQuestionTool } from "./user";

export type GraphToolsetOptions = {
    graphId: string;
    embeddingModel: EmbeddingModelV3;
};

export function buildGraphExplorationToolset({ graphId, embeddingModel }: GraphToolsetOptions) {
    return {
        list_files: listFilesTool(graphId),
        search_entities: searchEntityTool(graphId, embeddingModel),
        list_entities: listEntitiesTool(graphId),
        search_relationships: searchRelationshipsTool(graphId, embeddingModel),
        get_relationships: getRelationshipsTool(graphId),
        get_entity_neighbours: getNeighboursTool(graphId),
        get_path_between_entities: getPathBetweenTool(graphId),
    } satisfies ToolSet;
}

export function buildSourceGroundingToolset({ graphId, embeddingModel }: GraphToolsetOptions) {
    return {
        get_entity_sources: getEntitySourcesTool(graphId, embeddingModel),
        get_relationship_sources: getRelationshipSourcesTool(graphId, embeddingModel),
    } satisfies ToolSet;
}

export function buildSourceCurationToolset(options: GraphToolsetOptions) {
    return {
        ...buildSourceGroundingToolset(options),
        get_source_file_metadata: getSourceFileMetadataTool(options.graphId),
    } satisfies ToolSet;
}

export function buildServerToolset(options: GraphToolsetOptions) {
    return {
        ...buildGraphExplorationToolset(options),
        ...buildSourceGroundingToolset(options),
    } satisfies ToolSet;
}

export function buildServerAndClientToolset(options: GraphToolsetOptions) {
    return {
        ...buildServerToolset(options),
        ask_clarifying_questions: askQuestionTool(),
    } satisfies ToolSet;
}

export function buildMcpResearchToolset(options: GraphToolsetOptions) {
    return buildServerToolset(options);
}
