import type { ChatUIMessage } from "@kiwi/ai/ui";

function stripStaleStreamingMetadata(
    metadata: ChatUIMessage["metadata"] | undefined,
    previousMetadata: ChatUIMessage["metadata"]
): ChatUIMessage["metadata"] | undefined {
    if (!metadata) return metadata;

    const {
        durationMs: _durationMs,
        totalTokens: _totalTokens,
        inputTokens: _inputTokens,
        outputTokens: _outputTokens,
        tokensPerSecond: _tokensPerSecond,
        timeToFirstToken: _timeToFirstToken,
        consideredFileCount: _consideredFileCount,
        usedFileCount: _usedFileCount,
        createdAt,
        ...rest
    } = metadata;

    const next = {
        ...rest,
        ...(createdAt !== undefined && createdAt !== previousMetadata?.createdAt ? { createdAt } : {}),
    };

    return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * When `shouldAutoContinue` triggers a follow-up turn after the user has
 * answered a client-side tool call (e.g. `ask_clarifying_questions`), the AI
 * SDK seeds the streaming state of the new assistant bubble with a
 * `structuredClone` of the previous assistant message's parts (see
 * `createStreamingUIMessageState` in `ai/src/ui/process-ui-message-stream.ts`
 * together with `AbstractChat.makeRequest`). When the backend emits a fresh
 * `messageId` in its `start` event, the SDK pushes that cloned-and-renamed
 * object as a separate bubble, carrying the previous message's parts as a
 * phantom prefix.
 *
 * The SDK has no hook to reset those phantom parts, so we strip them at the
 * data boundary. The cloned message can also keep the previous finished
 * message's metadata; those stale duration/token fields must be removed so the
 * new bubble renders a live timer instead of the previous "Worked for" value.
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
        if (JSON.stringify(last.parts[i]) !== JSON.stringify(prev.parts[i])) {
            return messages;
        }
    }

    const stripped: ChatUIMessage = {
        ...last,
        metadata: stripStaleStreamingMetadata(last.metadata, prev.metadata),
        parts: last.parts.slice(prefixLen),
    };
    return [...messages.slice(0, -1), stripped];
}
