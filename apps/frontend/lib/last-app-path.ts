const LAST_APP_PATH_KEY = "kiwi-last-app-path";

/**
 * Records the most recent non-settings location so the settings "Back to app"
 * action can return the user to where they were. Settings paths are ignored so
 * navigating between Sections never overwrites the remembered location.
 */
export function recordLastAppPath(path: string) {
    if (typeof window === "undefined" || path.startsWith("/settings")) {
        return;
    }
    window.sessionStorage.setItem(LAST_APP_PATH_KEY, path);
}

export function getLastAppPath(): string | null {
    if (typeof window === "undefined") {
        return null;
    }
    const value = window.sessionStorage.getItem(LAST_APP_PATH_KEY);
    // Only return an in-app, relative path. Reject anything that isn't "/"-rooted,
    // protocol-relative ("//host"), or points back into settings.
    if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/settings")) {
        return null;
    }
    return value;
}
