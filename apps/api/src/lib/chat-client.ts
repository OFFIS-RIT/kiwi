import { getClient, type Client } from "@kiwi/ai";
import { resolveResearchModelConfig } from "@kiwi/ai/models";
import * as Effect from "effect/Effect";
import { env } from "../env";
import { API_ERROR_CODES } from "../types";

export type RequiredResearchClient = Client & {
    text: NonNullable<Client["text"]>;
    embedding: NonNullable<Client["embedding"]>;
    textModelId: string;
    contextWindow: number;
    compactionContextWindow: number;
};

export function getRequiredResearchClient(options: {
    organizationId: string;
    requestedModelId?: string;
}): Effect.Effect<RequiredResearchClient, unknown> {
    return Effect.gen(function* () {
        const resolvedModels = yield* resolveResearchModelConfig({
            organizationId: options.organizationId,
            requestedTextModelId: options.requestedModelId,
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
            textModelId: resolvedModels.textModelId,
            contextWindow: resolvedModels.contextWindow,
            compactionContextWindow: resolvedModels.compactionContextWindow,
        };
    });
}
