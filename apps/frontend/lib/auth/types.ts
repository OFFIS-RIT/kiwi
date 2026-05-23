/**
 * Minimaler User-Slice, der vom Server-Layout an den Client übergeben wird.
 * Alles andere (Tokens, IP, UserAgent) bleibt server-only.
 */
export type InitialClientSession = {
    user: {
        id: string;
        name: string;
        email: string;
        image: string | null;
        role: string | null;
    };
};
