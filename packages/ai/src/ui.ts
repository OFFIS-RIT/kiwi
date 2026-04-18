import type { UIMessage, UITools } from "ai";

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

export type ChatUIMessage = UIMessage<ChatMessageMetadata, ChatDataParts, UITools>;
