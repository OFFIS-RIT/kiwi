import { getClient } from "@kiwi/ai";
import { resolveResearchModelConfig } from "@kiwi/ai/models";
import { env } from "../env";
import { API_ERROR_CODES } from "../types";

export async function getRequiredResearchClient(options: {
    organizationId: string;
    requestedModelId?: string;
}) {
    const resolvedModels = await resolveResearchModelConfig({
        organizationId: options.organizationId,
        requestedTextModelId: options.requestedModelId,
        secret: env.AUTH_SECRET,
    });
    const client = getClient(resolvedModels.config);

    if (!client.text || !client.embedding) {
        throw new Error(API_ERROR_CODES.MODEL_NOT_CONFIGURED);
    }

    return {
        ...client,
        text: client.text,
        embedding: client.embedding,
        textModelId: resolvedModels.textModelId,
    };
}

export type RequiredResearchClient = Awaited<ReturnType<typeof getRequiredResearchClient>>;
