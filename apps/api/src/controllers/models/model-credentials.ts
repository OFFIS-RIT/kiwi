import { assertValidModelConfiguration, type ModelCredentials } from "@kiwi/ai/models";
import type { AiModelAdapter, AiModelType, ModelCredentialsPatchInput } from "@kiwi/contracts/models";

export function normalizeCredentials(credentials: ModelCredentials): ModelCredentials {
    return {
        apiKey: credentials.apiKey.trim(),
        ...(credentials.url ? { url: credentials.url.trim() } : {}),
        ...(credentials.resourceName ? { resourceName: credentials.resourceName.trim() } : {}),
    };
}

export function mergeCredentials(stored: ModelCredentials, patch: ModelCredentialsPatchInput): ModelCredentials {
    return normalizeCredentials({
        apiKey: patch.apiKey ?? stored.apiKey,
        url: patch.url !== undefined ? patch.url : stored.url,
        resourceName: patch.resourceName !== undefined ? patch.resourceName : stored.resourceName,
    });
}

export function assertCreateModelInput(input: {
    type: AiModelType;
    adapter: AiModelAdapter;
    providerModel: string;
    credentials: ModelCredentials;
}) {
    assertValidModelConfiguration(input);
}
