import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateText, stepCountIs, ToolLoopAgent, tool, type ToolSet } from "ai";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { withAiSlotEffect, type AiSlotError } from "../concurrency";
import { createCompactionPrompt, createCompactionTaskPrompt } from "../prompts/compaction.prompt";
import { prependPromptGuidance, type ScopedPromptGuidance } from "../prompts/guidance.prompt";
import {
    createExploreSubagentPrompt,
    createExploreSubagentTaskPrompt,
    createSourceCuratorSubagentPrompt,
    createSourceCuratorTaskPrompt,
} from "../prompts/subagent.prompt";
import type { RequestInformation } from "../prompts/request-info.prompt";
import { buildGraphExplorationToolset, buildSourceCurationToolset, type GraphToolsetOptions } from "../tools/toolsets";

type SubagentOptions = GraphToolsetOptions & {
    model: LanguageModelV3;
    promptGuidance?: ScopedPromptGuidance;
    requestInformation?: RequestInformation;
};

export function createGraphExploreAgent({
    model,
    graphId,
    embeddingModel,
    requestInformation,
    onConsideredFileIds,
}: SubagentOptions) {
    return new ToolLoopAgent({
        id: "graph-explore-agent",
        model,
        instructions: createExploreSubagentPrompt({ requestInformation }),
        tools: buildGraphExplorationToolset({ graphId, embeddingModel, onConsideredFileIds }),
        temperature: 0.2,
        stopWhen: stepCountIs(30),
    });
}

export function createSourceCuratorAgent({
    model,
    graphId,
    embeddingModel,
    requestInformation,
    onConsideredFileIds,
}: SubagentOptions) {
    return new ToolLoopAgent({
        id: "source-curator-agent",
        model,
        instructions: createSourceCuratorSubagentPrompt({ requestInformation }),
        tools: buildSourceCurationToolset({ graphId, embeddingModel, onConsideredFileIds }),
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

function combineAbortSignals(
    slotSignal: AbortSignal,
    externalSignal: AbortSignal | undefined
): AbortSignal | undefined {
    if (!externalSignal) {
        return undefined;
    }
    if (slotSignal.aborted) {
        return slotSignal;
    }
    if (externalSignal.aborted) {
        return externalSignal;
    }
    return AbortSignal.any([slotSignal, externalSignal]);
}

export function buildSubagentToolset(options: SubagentOptions) {
    const exploreAgent = createGraphExploreAgent(options);
    const sourceCuratorAgent = createSourceCuratorAgent(options);

    return {
        explore_graph_with_subagent: tool({
            description:
                "Delegate broad or deep graph exploration to a specialized subagent. Use this when the request may require many graph lookups before deciding what evidence matters.",
            inputSchema: exploreGraphSchema,
            execute: ({ task }, { abortSignal }) => {
                const program = withAiSlotEffect("text", (signal) =>
                    exploreAgent.generate({
                        prompt: prependPromptGuidance(createExploreSubagentTaskPrompt(task), options.promptGuidance),
                        abortSignal: combineAbortSignals(signal, abortSignal),
                    })
                ).pipe(Effect.map((result) => result.text));

                return Effect.runPromise(program);
            },
        }),
        curate_sources_with_subagent: tool({
            description:
                "Delegate source selection to a specialized subagent after candidate entities or relationships are known. It returns relevant source IDs for final citations.",
            inputSchema: curateSourcesSchema,
            execute: ({ task, entityIds, relationshipIds, query, files }, { abortSignal }) => {
                const program = withAiSlotEffect("text", (signal) =>
                    sourceCuratorAgent.generate({
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
                        abortSignal: combineAbortSignals(signal, abortSignal),
                    })
                ).pipe(Effect.map((result) => result.text));

                return Effect.runPromise(program);
            },
        }),
    } satisfies ToolSet;
}

export function compactConversationHistory(options: {
    model: LanguageModelV3;
    transcript: string;
    promptGuidance?: ScopedPromptGuidance;
    previousSummary?: string;
    abortSignal?: AbortSignal;
}): Effect.Effect<string, AiSlotError> {
    return Effect.gen(function* () {
        const compactionGuidance = {
            graphPrompts: options.promptGuidance?.graphPrompts,
        };

        const result = yield* withAiSlotEffect("text", (signal) =>
            generateText({
                model: options.model,
                system: createCompactionPrompt(),
                prompt: prependPromptGuidance(
                    createCompactionTaskPrompt({
                        previousSummary: options.previousSummary,
                        transcript: options.transcript,
                    }),
                    compactionGuidance
                ),
                temperature: 0.1,
                maxOutputTokens: 6_000,
                abortSignal: combineAbortSignals(signal, options.abortSignal),
            })
        );

        return result.text;
    });
}
