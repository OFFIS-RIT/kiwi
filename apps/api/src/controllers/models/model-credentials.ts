import {
    assertValidModelConfiguration,
    normalizeModelId,
    type ModelCredentials,
} from "@kiwi/ai/models";
import { db } from "@kiwi/db";
import { modelsTable } from "@kiwi/db/tables/models";
import { modelNotFoundError } from "@kiwi/contracts/errors";
import type { AiModelAdapter, AiModelType, ModelCredentialsPatchInput } from "@kiwi/contracts/models";
import { and, eq } from "drizzle-orm";
import { tryApiPromise } from "../_shared/api-effect";

export type ModelQueryRunner = {
    select: typeof db.select;
};

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

export function getModelForUpdate(queryRunner: ModelQueryRunner, organizationId: string, modelId: string) {
    return tryApiPromise(async () => {
        const [model] = await queryRunner
            .select()
            .from(modelsTable)
            .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.modelId, normalizeModelId(modelId))))
            .limit(1);
    
        if (!model) {
            throw modelNotFoundError();
        }
    
        return model;
    });
}
