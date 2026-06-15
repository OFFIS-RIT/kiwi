import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyHmacSha256Signature(options: {
    body: string | Buffer | Uint8Array;
    secret: string;
    signatureHeader: string | null | undefined;
    prefix: string;
}): boolean {
    if (!options.signatureHeader || options.secret.length === 0) {
        return false;
    }

    const expected = `${options.prefix}${createHmac("sha256", options.secret).update(options.body).digest("hex")}`;
    const received = Buffer.from(options.signatureHeader, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    return received.byteLength === expectedBytes.byteLength && timingSafeEqual(received, expectedBytes);
}

export function verifySharedSecretToken(receivedToken: string | null | undefined, expectedToken: string): boolean {
    if (!receivedToken || expectedToken.length === 0) {
        return false;
    }

    const received = Buffer.from(receivedToken, "utf8");
    const expected = Buffer.from(expectedToken, "utf8");
    return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}

export function branchNameFromGitRef(ref: unknown): string | null {
    if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) {
        return null;
    }
    return ref.slice("refs/heads/".length) || null;
}
