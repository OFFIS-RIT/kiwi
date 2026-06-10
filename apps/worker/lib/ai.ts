import { getClient } from "@kiwi/ai";
import { resolveGraphModelOrganizationId, resolveWorkerModelConfig } from "@kiwi/ai/models";
import { API_ERROR_CODES } from "@kiwi/contracts/responses";
import { env } from "../env";

export async function createWorkerClient(graphId: string) {
    const organizationId = await resolveGraphModelOrganizationId(graphId);
    const resolvedModels = await resolveWorkerModelConfig({
        organizationId,
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
    };
}
