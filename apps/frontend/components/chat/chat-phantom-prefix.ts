import type { ChatUIMessage } from "@kiwi/ai/ui";

function sameJsonValue(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function stripClonedFinishMetrics(
    metadata: ChatUIMessage["metadata"],
    previousMetadata: ChatUIMessage["metadata"]
): ChatUIMessage["metadata"] {
    if (!metadata || !previousMetadata || metadata.durationMs !== previousMetadata.durationMs) {
        return metadata;
    }

    const {
        durationMs: _durationMs,
        totalTokens: _totalTokens,
        inputTokens: _inputTokens,
        outputTokens: _outputTokens,
        tokensPerSecond: _tokensPerSecond,
        timeToFirstToken: _timeToFirstToken,
        usedFileCount: _usedFileCount,
        ...liveMetadata
    } = metadata;

    return liveMetadata;
}

/**
 * When `shouldAutoContinue` triggers a follow-up turn after the user has
 * answered a client-side tool call (e.g. `ask_clarifying_questions`), the AI
 * SDK seeds the streaming state of the new assistant bubble with a
 * `structuredClone` of the previous assistant message. When the backend emits
 * a fresh `messageId`, the SDK pushes that cloned-and-renamed object as a
 * separate bubble, carrying the previous message's parts and metadata as a
 * phantom prefix.
 */
export function stripPhantomPrefix(messages: ChatUIMessage[]): ChatUIMessage[] {
    if (messages.length < 2) return messages;

    const last = messages[messages.length - 1];
    const prev = messages[messages.length - 2];

    if (!last || !prev || last.role !== "assistant" || prev.role !== "assistant") {
        return messages;
    }

    if (!prev.metadata) return messages;

    const prefixLen = prev.parts.length;
    if (prefixLen === 0 || last.parts.length < prefixLen) return messages;

    for (let i = 0; i < prefixLen; i++) {
        if (!sameJsonValue(last.parts[i], prev.parts[i])) {
            return messages;
        }
    }

    const clonedPreviousMetadata = sameJsonValue(last.metadata, prev.metadata);
    const stripped: ChatUIMessage = {
        ...last,
        parts: last.parts.slice(prefixLen),
        metadata: clonedPreviousMetadata
            ? undefined
            : stripClonedFinishMetrics(last.metadata, prev.metadata),
    };
    return [...messages.slice(0, -1), stripped];
}
