import type { InferUITools, UIMessage } from "ai";
import { z } from "zod";
import type { buildSubagentToolset } from "./agents/subagents";
import type { buildServerAndClientToolset } from "./tools/toolsets";

export type ChatMessageMetadata = {
    createdAt?: string;
    modelId?: string;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    tokensPerSecond?: number;
    timeToFirstToken?: number;
    durationMs?: number;
    consideredFileCount?: number;
    usedFileCount?: number;
};

export type ChatDataParts = {
    step: {
        name: string;
    };
};

type ChatValidationToolset = ReturnType<typeof buildServerAndClientToolset> & ReturnType<typeof buildSubagentToolset>;

export type ChatUIMessage = UIMessage<ChatMessageMetadata, ChatDataParts, InferUITools<ChatValidationToolset>>;

export const chatMessageMetadataSchema = z.object({
    createdAt: z.string().optional(),
    modelId: z.string().optional(),
    totalTokens: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    tokensPerSecond: z.number().optional(),
    timeToFirstToken: z.number().optional(),
    durationMs: z.number().optional(),
    consideredFileCount: z.number().optional(),
    usedFileCount: z.number().optional(),
});

export const chatDataPartSchemas = {
    step: z.object({
        name: z.string(),
    }),
};
