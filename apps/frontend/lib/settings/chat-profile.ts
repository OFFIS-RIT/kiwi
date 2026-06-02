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
