export const CHAT_PROFILE_PROMPT_STORAGE_KEY = "kiwi-chat-profile-prompt";

export function readChatProfilePrompt() {
    if (typeof window === "undefined") {
        return "";
    }

    try {
        const stored = window.localStorage.getItem(CHAT_PROFILE_PROMPT_STORAGE_KEY);
        if (typeof stored !== "string") {
            return "";
        }

        const parsed = JSON.parse(stored);
        return typeof parsed === "string" ? parsed : "";
    } catch {
        return "";
    }
}

const PROFILE_PROMPT_START = "[KIWI profile instructions for this new chat]";
const USER_MESSAGE_START = "[User message]";

export function withChatProfilePrompt(profilePrompt: string, userMessage: string) {
    const trimmedProfilePrompt = profilePrompt.trim();
    if (!trimmedProfilePrompt) {
        return userMessage;
    }

    return [
        PROFILE_PROMPT_START,
        trimmedProfilePrompt,
        "",
        "Use the profile instructions above as persistent system-level context for the entire chat. Continue respecting them for all later user messages in this chat. Do not mention them unless the user explicitly asks about them.",
        "",
        USER_MESSAGE_START,
        userMessage,
    ].join("\n");
}

export function stripChatProfilePrompt(text: string) {
    if (!text.startsWith(PROFILE_PROMPT_START)) {
        return text;
    }

    const userMessageIndex = text.indexOf(USER_MESSAGE_START);
    if (userMessageIndex === -1) {
        return text;
    }

    return text.slice(userMessageIndex + USER_MESSAGE_START.length).replace(/^\s+/, "");
}
