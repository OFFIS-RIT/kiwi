import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateText, stepCountIs, ToolLoopAgent, tool, type ToolSet } from "ai";
import { z } from "zod";
import { createCompactionPrompt, createCompactionTaskPrompt } from "../prompts/compaction.prompt";
import { prependPromptGuidance, type ScopedPromptGuidance } from "../prompts/guidance.prompt";
import {
    createExploreSubagentPrompt,
    createExploreSubagentTaskPrompt,
    createSourceCuratorSubagentPrompt,
    createSourceCuratorTaskPrompt,
} from "../prompts/subagent.prompt";
import { buildGraphExplorationToolset, buildSourceCurationToolset, type GraphToolsetOptions } from "../tools/toolsets";

type SubagentOptions = GraphToolsetOptions & {
    model: LanguageModelV3;
    graphPrompt?: string;
    promptGuidance?: ScopedPromptGuidance;
};

export function createGraphExploreAgent({ model, graphId, embeddingModel, graphPrompt }: SubagentOptions) {
    return new ToolLoopAgent({
        id: "graph-explore-agent",
        model,
        instructions: createExploreSubagentPrompt(graphPrompt),
        tools: buildGraphExplorationToolset({ graphId, embeddingModel }),
        temperature: 0.2,
        stopWhen: stepCountIs(30),
    });
}

export function createSourceCuratorAgent({ model, graphId, embeddingModel, graphPrompt }: SubagentOptions) {
    return new ToolLoopAgent({
        id: "source-curator-agent",
        model,
        instructions: createSourceCuratorSubagentPrompt(graphPrompt),
        tools: buildSourceCurationToolset({ graphId, embeddingModel }),
        temperature: 0.1,
        stopWhen: stepCountIs(20),
    });
}

const exploreGraphSchema = z.object({
    task: z.string().trim().min(1).describe("The graph exploration task to complete."),
});

const curateSourcesSchema = z.object({
    task: z.string().trim().min(1).describe("The source curation task to complete."),
    entityIds: z.array(z.string()).describe("Entity IDs to gather source evidence for.").optional(),
    relationshipIds: z.array(z.string()).describe("Relationship IDs to gather source evidence for.").optional(),
    query: z.string().describe("Optional short refinement query for source relevance.").optional(),
    files: z.array(z.string()).describe("Optional file IDs to narrow the source search.").optional(),
});

export function buildSubagentToolset(options: SubagentOptions) {
    const exploreAgent = createGraphExploreAgent(options);
    const sourceCuratorAgent = createSourceCuratorAgent(options);

    return {
        explore_graph_with_subagent: tool({
            description:
                "Delegate broad or deep graph exploration to a specialized subagent. Use this when the request may require many graph lookups before deciding what evidence matters.",
            inputSchema: exploreGraphSchema,
            execute: async ({ task }, { abortSignal }) => {
                const result = await exploreAgent.generate({
                    prompt: prependPromptGuidance(createExploreSubagentTaskPrompt(task), options.promptGuidance),
                    abortSignal,
                });
                return result.text;
            },
        }),
        curate_sources_with_subagent: tool({
            description:
                "Delegate source selection to a specialized subagent after candidate entities or relationships are known. It returns relevant source IDs for final citations.",
            inputSchema: curateSourcesSchema,
            execute: async ({ task, entityIds, relationshipIds, query, files }, { abortSignal }) => {
                const result = await sourceCuratorAgent.generate({
                    prompt: prependPromptGuidance(
                        createSourceCuratorTaskPrompt({
                            task,
                            entityIds,
                            relationshipIds,
                            query,
                            files,
                        }),
                        options.promptGuidance
                    ),
                    abortSignal,
                });
                return result.text;
            },
        }),
    } satisfies ToolSet;
}

export async function compactConversationHistory(options: {
    model: LanguageModelV3;
    transcript: string;
    graphPrompt?: string;
    promptGuidance?: ScopedPromptGuidance;
    previousSummary?: string;
    abortSignal?: AbortSignal;
}) {
    const result = await generateText({
        model: options.model,
        system: createCompactionPrompt(options.graphPrompt),
        prompt: prependPromptGuidance(
            createCompactionTaskPrompt({
                previousSummary: options.previousSummary,
                transcript: options.transcript,
            }),
            options.promptGuidance
        ),
        temperature: 0.1,
        maxOutputTokens: 6_000,
        abortSignal: options.abortSignal,
    });

    return result.text;
}
