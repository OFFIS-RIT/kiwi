import * as Effect from "effect/Effect";
import { getClient } from "@kiwi/ai";
import { resolveGraphModelOrganizationId, resolveWorkerModelConfig } from "@kiwi/ai/models";
import { API_ERROR_CODES } from "@kiwi/contracts/responses";
import { env } from "../env";

export function createWorkerClient(graphId: string) {
    return Effect.gen(function* () {
        const organizationId = yield* resolveGraphModelOrganizationId(graphId);
        const resolvedModels = yield* resolveWorkerModelConfig({
            organizationId,
            secret: env.AUTH_SECRET,
        });
        const client = getClient(resolvedModels.config);

        if (!client.text || !client.embedding) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.MODEL_NOT_CONFIGURED));
        }

        return {
            ...client,
            text: client.text,
            embedding: client.embedding,
        };
    });
}
