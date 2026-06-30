import type { LanguageModel } from "ai";
import { generateText, isStepCount, ToolLoopAgent, tool, type ToolSet } from "ai";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { AI_REQUEST_TIMEOUT, withAiSlotEffect, type AiProviderError } from "../concurrency";
import { createCompactionPrompt, createCompactionTaskPrompt } from "../prompts/compaction.prompt";
import { prependPromptGuidance, type ScopedPromptGuidance } from "../prompts/guidance.prompt";
import {
    createCodeSearchSubagentPrompt,
    createCodeSearchSubagentTaskPrompt,
    createExploreSubagentPrompt,
    createExploreSubagentTaskPrompt,
    createSourceCuratorSubagentPrompt,
    createSourceCuratorTaskPrompt,
} from "../prompts/subagent.prompt";
import type { RequestInformation } from "../prompts/request-info.prompt";
import {
    buildCodeSearchToolset,
    buildGraphExplorationToolset,
    buildSourceCurationToolset,
    type GraphToolsetOptions,
} from "../tools/toolsets";

type SubagentOptions = GraphToolsetOptions & {
    model: LanguageModel;
    promptGuidance?: ScopedPromptGuidance;
    requestInformation?: RequestInformation;
    includeCodeSearch?: boolean;
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
        stopWhen: isStepCount(30),
        timeout: AI_REQUEST_TIMEOUT,
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
        stopWhen: isStepCount(20),
        timeout: AI_REQUEST_TIMEOUT,
    });
}

export function createCodeSearchAgent({
    model,
    graphId,
    embeddingModel,
    requestInformation,
    onConsideredFileIds,
}: SubagentOptions) {
    return new ToolLoopAgent({
        id: "code-search-agent",
        model,
        instructions: createCodeSearchSubagentPrompt({ requestInformation }),
        tools: buildCodeSearchToolset({ graphId, embeddingModel, onConsideredFileIds }),
        temperature: 0.1,
        stopWhen: isStepCount(24),
        timeout: AI_REQUEST_TIMEOUT,
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

const codeSearchSchema = z.object({
    task: z.string().trim().min(1).describe("The code search task to complete."),
    query: z.string().describe("Optional natural-language or symbol query anchor.").optional(),
    paths: z.array(z.string()).describe("Optional repository paths to prioritize.").optional(),
    symbols: z
        .array(z.string())
        .describe("Optional graph entity or symbol IDs already known to be relevant.")
        .optional(),
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

function createCodeSearchTool(options: SubagentOptions, codeSearchAgent: ReturnType<typeof createCodeSearchAgent>) {
    return tool({
        description:
            "Delegate code-focused graph exploration to a specialized subagent. Use this for questions about implementation, symbols, imports, calls, or file-level code evidence.",
        inputSchema: codeSearchSchema,
        execute: ({ task, query, paths, symbols }, { abortSignal }) => {
            const program = withAiSlotEffect("text", (signal) =>
                codeSearchAgent.generate({
                    prompt: prependPromptGuidance(
                        createCodeSearchSubagentTaskPrompt({ task, query, paths, symbols }),
                        options.promptGuidance
                    ),
                    abortSignal: combineAbortSignals(signal, abortSignal),
                })
            ).pipe(Effect.map((result) => result.text));

            return Effect.runPromise(program);
        },
    });
}

export function buildSubagentToolset(options: SubagentOptions) {
    const exploreAgent = createGraphExploreAgent(options);
    const sourceCuratorAgent = createSourceCuratorAgent(options);
    const codeSearchAgent = options.includeCodeSearch === false ? undefined : createCodeSearchAgent(options);

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
        ...(codeSearchAgent ? { code_search: createCodeSearchTool(options, codeSearchAgent) } : {}),
    } satisfies ToolSet;
}

export function buildCodeSearchSubagentToolset(options: SubagentOptions) {
    const codeSearchAgent = createCodeSearchAgent(options);

    return {
        code_search: createCodeSearchTool(options, codeSearchAgent),
    } satisfies ToolSet;
}

export function compactConversationHistory(options: {
    model: LanguageModel;
    transcript: string;
    promptGuidance?: ScopedPromptGuidance;
    previousSummary?: string;
    abortSignal?: AbortSignal;
}): Effect.Effect<string, AiProviderError> {
    return Effect.gen(function* () {
        const compactionGuidance = {
            graphPrompts: options.promptGuidance?.graphPrompts,
        };

        const result = yield* withAiSlotEffect("text", (signal) =>
            generateText({
                model: options.model,
                instructions: createCompactionPrompt(),
                prompt: prependPromptGuidance(
                    createCompactionTaskPrompt({
                        previousSummary: options.previousSummary,
                        transcript: options.transcript,
                    }),
                    compactionGuidance
                ),
                temperature: 0.1,
                maxOutputTokens: 6_000,
                timeout: AI_REQUEST_TIMEOUT,
                abortSignal: combineAbortSignals(signal, options.abortSignal),
            })
        );

        return result.text;
    });
}
