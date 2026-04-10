import type { UIMessage } from "ai";

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

export type CitationData = {
    id: string;
    sourceId: string;
    textUnitId: string;
    fileId: string;
    fileName: string;
    fileKey: string;
    excerpt?: string;
    description?: string;
};

export type ChatDataParts = {
    citation: CitationData;
    step: {
        name: string;
    };
};

export type ChatMessage = UIMessage<ChatMessageMetadata, ChatDataParts>;

export type ChatSessionSummary = {
    id: string;
    title: string;
    updatedAt: string | null;
};

export type ChatHistoryResponse = {
    id: string;
    title: string;
    messages: ChatMessage[];
};
