import { z } from "zod";
export type { ChatDataParts, ChatMessageMetadata, ChatUIMessage } from "@kiwi/contracts/chat";

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
