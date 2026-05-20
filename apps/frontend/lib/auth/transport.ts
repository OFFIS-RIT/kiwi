import "server-only";

/**
 * Thin wrapper around fetch für Server-zu-Auth-Service-Communication.
 * Existiert getrennt, damit Tests via vi.mock("./transport") die HTTP-Schicht ersetzen können
 * ohne den gesamten getServerSession-Code zu mocken.
 */
export async function fetchSessionRaw(authBaseUrl: string, cookie: string): Promise<unknown | null> {
    const res = await fetch(`${authBaseUrl}/get-session`, {
        headers: { cookie },
        cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json();
}
