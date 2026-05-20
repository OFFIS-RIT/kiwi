import "server-only";

/**
 * Thin wrapper around fetch für Server-zu-Auth-Service-Communication.
 * Existiert getrennt, damit Tests via vi.mock("./transport") die HTTP-Schicht ersetzen können
 * ohne den gesamten getServerSession-Code zu mocken.
 */
export async function fetchSessionRaw(authBaseUrl: string, cookie: string): Promise<unknown | null> {
    try {
        const res = await fetch(`${authBaseUrl}/get-session`, {
            headers: { cookie },
            cache: "no-store",
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (error) {
        // Auth-Service nicht erreichbar (ECONNREFUSED, DNS, Timeout, JSON-Parse-Fehler).
        // Behandle wie "keine Session" — callers redirecten zu /login, statt die Error-Boundary
        // zu treffen und die Login-Seite selbst unzugänglich zu machen.
        console.warn("fetchSessionRaw failed:", error);
        return null;
    }
}
