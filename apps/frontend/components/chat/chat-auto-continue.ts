import type { UIMessage } from "ai";

type SendAutomaticallyWhen = (options: { messages: UIMessage[] }) => boolean | PromiseLike<boolean>;

type ChatEntryInitWithAutoContinue = {
    sendAutomaticallyWhen?: SendAutomaticallyWhen;
};

function isEmptyTextPart(part: UIMessage["parts"][number]) {
    return part.type === "text" && part.text.trim().length === 0;
}

function getLastSubstantivePart(message: UIMessage) {
    for (let i = message.parts.length - 1; i >= 0; i--) {
        const part = message.parts[i];
        if (!part || isEmptyTextPart(part)) continue;
        return part;
    }
    return undefined;
}

/**
 * Auto-send trigger predicate for `useChat`.
 *
 * We only want to auto-continue when the user has just answered a client-side
 * clarification and the LLM has not responded to it yet. The AI SDK mutates
 * the last assistant message in place when a response streams in, appending
 * new parts after the existing ones. That means the answered clarification
 * tool part stays exactly where it was. As long as it is the very last part
 * of the message, we know no follow-up response exists yet.
 */
export function shouldAutoContinue({ messages }: { messages: UIMessage[] }): boolean {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return false;

    const lastPart = getLastSubstantivePart(last);
    if (!lastPart || !("type" in lastPart)) return false;
    if (lastPart.type !== "tool-ask_clarifying_questions") return false;
    if (!("state" in lastPart)) return false;
    return lastPart.state === "output-available";
}

export function withDefaultAutoContinue<T extends ChatEntryInitWithAutoContinue>(init: T): T {
    return {
        ...init,
        sendAutomaticallyWhen: init.sendAutomaticallyWhen ?? shouldAutoContinue,
    };
}
