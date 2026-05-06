import type { LanguageModelV3 } from "@ai-sdk/provider";
import { stepCountIs, ToolLoopAgent, tool, type ToolSet } from "ai";
import { z } from "zod";
import { createExploreSubagentPrompt, createSourceCuratorSubagentPrompt } from "../prompts/subagent.prompt";
import { buildGraphExplorationToolset, buildSourceCurationToolset, type GraphToolsetOptions } from "../tools/toolsets";

type SubagentOptions = GraphToolsetOptions & {
    model: LanguageModelV3;
    graphPrompt?: string;
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

function line(label: string, values?: string[]) {
    const uniqueValues = [...new Set(values?.map((value) => value.trim()).filter(Boolean) ?? [])];
    return uniqueValues.length > 0 ? `${label}: ${uniqueValues.join(", ")}` : undefined;
}

function textOrFallback(text: string, fallback: string) {
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : fallback;
}

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
                    prompt: [
                        "Complete this graph exploration task for the parent agent.",
                        `Task: ${task}`,
                        "Return only findings the parent can use: relevant file IDs, entity IDs, relationship IDs, paths, and unresolved gaps.",
                    ].join("\n"),
                    abortSignal,
                });

                return textOrFallback(result.text, "The graph exploration subagent found no relevant graph items.");
            },
        }),
        curate_sources_with_subagent: tool({
            description:
                "Delegate source selection to a specialized subagent after candidate entities or relationships are known. It returns relevant source IDs for final citations.",
            inputSchema: curateSourcesSchema,
            execute: async ({ task, entityIds, relationshipIds, query, files }, { abortSignal }) => {
                const result = await sourceCuratorAgent.generate({
                    prompt: [
                        "Find the best source evidence for the parent agent.",
                        `Task: ${task}`,
                        line("Entity IDs", entityIds),
                        line("Relationship IDs", relationshipIds),
                        line("File IDs", files),
                        query?.trim() ? `Refinement query: ${query.trim()}` : undefined,
                        "Return source IDs that directly support the task. Include enough context for the parent to decide which citations to use.",
                    ]
                        .filter((entry): entry is string => typeof entry === "string")
                        .join("\n"),
                    abortSignal,
                });

                return textOrFallback(result.text, "The source curator subagent found no relevant sources.");
            },
        }),
    } satisfies ToolSet;
}
