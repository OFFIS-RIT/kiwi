import * as Effect from "effect/Effect";
import { env } from "../env";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const TOKEN_TTL_SECONDS = 60 * 60;

type ProjectFileAccessTokenPayload = {
    graphId: string;
    fileId: string;
    exp: number;
};

let signingKeyPromise: Promise<CryptoKey> | null = null;
let signingKeySecret: string | null = null;

export function importProjectFileAccessTokenSigningKey(
    secret: string,
    keyImporter: Pick<SubtleCrypto, "importKey"> = crypto.subtle
): Effect.Effect<CryptoKey, unknown> {
    return Effect.tryPromise({
        try: () =>
            keyImporter.importKey(
                "raw",
                textEncoder.encode(secret),
                { name: "HMAC", hash: "SHA-256" },
                false,
                ["sign", "verify"]
            ),
        catch: (error) => new Error("Failed to import AUTH_SECRET as an HMAC signing key", { cause: error }),
    });
}

function getSigningKey(): Effect.Effect<CryptoKey, unknown> {
    const secret = env.AUTH_SECRET;
    if (!signingKeyPromise || signingKeySecret !== secret) {
        signingKeySecret = secret;
        signingKeyPromise = Effect.runPromise(importProjectFileAccessTokenSigningKey(secret)).catch((error) => {
            signingKeyPromise = null;
            signingKeySecret = null;
            throw error;
        });
    }

    return Effect.tryPromise(() => signingKeyPromise!);
}

function base64UrlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
    try {
        const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
        const binary = atob(padded);

        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
        return null;
    }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);

    return buffer;
}

export function createProjectFileAccessToken(
    graphId: string,
    fileId: string,
    options: { expiresInSeconds?: number; now?: Date } = {}
): Effect.Effect<string, unknown> {
    return Effect.gen(function* () {
        const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
        const payload: ProjectFileAccessTokenPayload = {
            graphId,
            fileId,
            exp: nowSeconds + (options.expiresInSeconds ?? TOKEN_TTL_SECONDS),
        };
        const encodedPayload = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
        const signingKey = yield* getSigningKey();
        const signature = yield* Effect.tryPromise(() =>
            crypto.subtle.sign("HMAC", signingKey, textEncoder.encode(encodedPayload))
        );

        return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
    });
}

export function verifyProjectFileAccessToken(
    token: string | null | undefined,
    graphId: string,
    fileId: string,
    options: { now?: Date } = {}
): Effect.Effect<boolean, unknown> {
    return Effect.gen(function* () {
        if (!token) {
            return false;
        }

        const [encodedPayload, encodedSignature, extra] = token.split(".");
        if (!encodedPayload || !encodedSignature || extra !== undefined) {
            return false;
        }

        const signature = base64UrlDecode(encodedSignature);
        if (!signature) {
            return false;
        }

        const signingKey = yield* getSigningKey();
        const verified = yield* Effect.tryPromise(() =>
            crypto.subtle.verify("HMAC", signingKey, toArrayBuffer(signature), textEncoder.encode(encodedPayload))
        );
        if (!verified) {
            return false;
        }

        const payloadBytes = base64UrlDecode(encodedPayload);
        if (!payloadBytes) {
            return false;
        }

        try {
            const payload = JSON.parse(textDecoder.decode(payloadBytes)) as Partial<ProjectFileAccessTokenPayload>;
            const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);

            return (
                payload.graphId === graphId &&
                payload.fileId === fileId &&
                typeof payload.exp === "number" &&
                payload.exp >= nowSeconds
            );
        } catch {
            return false;
        }
    });
}
