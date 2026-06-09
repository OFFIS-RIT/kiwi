/**
 * Copies text to the clipboard.
 *
 * Uses the asynchronous Clipboard API when available. That API is only exposed
 * in secure contexts (HTTPS or localhost), so when the app is served over plain
 * HTTP via an IP address or hostname `navigator.clipboard` is `undefined`. In
 * that case we fall back to a hidden textarea and `document.execCommand("copy")`.
 */
export async function copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    try {
        const succeeded = document.execCommand("copy");
        if (!succeeded) {
            throw new Error("document.execCommand('copy') returned false");
        }
    } finally {
        document.body.removeChild(textarea);
        previouslyFocused?.focus();
    }
}
