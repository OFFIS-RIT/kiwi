import type { UIMessage } from "ai";

type ChatUITool = {
    // oxlint-disable-next-line no-explicit-any -- contracts cannot own every concrete AI tool input schema
    input: any;
    // oxlint-disable-next-line no-explicit-any -- contracts cannot own every concrete AI tool output schema
    output: any;
};

export type MessageTextPart = {
    type: "text";
    text: string;
};

export type MessageReasoningPart = {
    type: "reasoning";
    text: string;
};

export type MessageToolPart = {
    type: "tool";
    toolCallId: string;
    toolName: string;
    execution: "server" | "client";
    status: "pending" | "completed" | "failed";
    args: unknown;
    result?: unknown;
};

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

export type MessageMetadataPart = {
    type: "metadata";
    metadata: Omit<ChatMessageMetadata, "createdAt">;
};

export type MessageCompactionPart = {
    type: "compaction";
    version: 1;
    summary: string;
    summarizedThroughMessageId: string;
    basedOnCompactionMessageId?: string;
};

export type MessagePart =
    | MessageTextPart
    | MessageReasoningPart
    | MessageToolPart
    | MessageMetadataPart
    | MessageCompactionPart;

export type ChatDataParts = {
    step: {
        name: string;
    };
};

export type ChatUIMessage = UIMessage<ChatMessageMetadata, ChatDataParts, Record<string, ChatUITool>>;
