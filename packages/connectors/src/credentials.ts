import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { ConnectorCredentials, ConnectorInstallationCredentials, ConnectorProvider } from "./types";
import { connectorAdapterRegistry, isKnownConnectorProvider } from "./registry";

const ENCRYPTION_VERSION = "v1";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_SALT = "kiwi-connector-credentials:v1";
const ENCRYPTION_KEY_INFO = "connector-credential-encryption";
const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;

export type ConnectorSecretPayload = ConnectorCredentials | ConnectorInstallationCredentials | { secret: string };

export function encryptConnectorCredentials(credentials: ConnectorSecretPayload, secret: string): string {
    assertValidConnectorCredentials(credentials);
    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, deriveEncryptionKey(secret), iv, {
        authTagLength: AUTH_TAG_BYTE_LENGTH,
    });
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [ENCRYPTION_VERSION, encodeBase64Url(iv), encodeBase64Url(authTag), encodeBase64Url(ciphertext)].join(":");
}

export function decryptConnectorCredentials(value: string, secret: string): ConnectorSecretPayload {
    const [version, rawIv, rawAuthTag, rawCiphertext, extra] = value.split(":");
    if (version !== ENCRYPTION_VERSION || !rawIv || !rawAuthTag || !rawCiphertext || extra !== undefined) {
        throw new Error("Invalid connector credentials");
    }

    try {
        const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, deriveEncryptionKey(secret), decodeBase64Url(rawIv), {
            authTagLength: AUTH_TAG_BYTE_LENGTH,
        });
        decipher.setAuthTag(decodeBase64Url(rawAuthTag));
        const plaintext = Buffer.concat([decipher.update(decodeBase64Url(rawCiphertext)), decipher.final()]).toString(
            "utf8"
        );
        const parsed = JSON.parse(plaintext) as ConnectorSecretPayload;
        assertValidConnectorCredentials(parsed);
        return parsed;
    } catch (error) {
        throw new Error("Invalid connector credentials", { cause: error });
    }
}

export function encryptConnectorSecret(secretValue: string, secret: string): string {
    return encryptConnectorCredentials({ secret: secretValue }, secret);
}

export function decryptConnectorSecret(value: string, secret: string): string {
    const payload = decryptConnectorCredentials(value, secret);
    if (!isSecretPayload(payload)) {
        throw new Error("Invalid connector secret");
    }
    return payload.secret;
}

export function assertValidConnectorCredentials(value: unknown): asserts value is ConnectorSecretPayload {
    if (!isObject(value)) {
        throw new Error("Invalid connector credentials");
    }

    if (isSecretPayload(value)) {
        return;
    }

    // Per-provider credential shapes are validated by the adapter registry so this module
    // stays provider-agnostic; a new provider only registers its validators there.
    if (typeof value.provider === "string" && isKnownConnectorProvider(value.provider)) {
        const entry = connectorAdapterRegistry[value.provider];
        if (entry && (entry.validateCredentials?.(value) === true || entry.validateInstallation?.(value) === true)) {
            return;
        }
    }

    throw new Error("Invalid connector credentials");
}

// Registry-driven type guards shared by callers that decrypt stored payloads (worker
// sync + file reads). They validate the payload against the provider's registered shape
// so no consumer hardcodes the known provider list.
export function isConnectorCredentialsForProvider(
    value: ConnectorSecretPayload,
    provider: ConnectorProvider
): value is ConnectorCredentials {
    const record = value as Record<string, unknown>;
    const entry = connectorAdapterRegistry[provider];
    return record.provider === provider && entry?.validateCredentials?.(record) === true;
}

export function isInstallationCredentialsForProvider(
    value: ConnectorSecretPayload,
    provider: ConnectorProvider
): value is ConnectorInstallationCredentials {
    const record = value as Record<string, unknown>;
    const entry = connectorAdapterRegistry[provider];
    return record.provider === provider && entry?.validateInstallation?.(record) === true;
}

function deriveEncryptionKey(secret: string): Buffer {
    return Buffer.from(hkdfSync("sha256", secret, ENCRYPTION_KEY_SALT, ENCRYPTION_KEY_INFO, 32));
}

function encodeBase64Url(value: Buffer): string {
    return value.toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
    return Buffer.from(value, "base64url");
}

function isSecretPayload(value: object): value is { secret: string } {
    return hasNonEmptyString(value, "secret");
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNonEmptyString(value: object, key: string): boolean {
    const record = value as Record<string, unknown>;
    return typeof record[key] === "string" && record[key].trim().length > 0;
}
