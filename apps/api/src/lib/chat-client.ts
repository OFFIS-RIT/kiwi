import { makeAiClient, type AiClientFactory, type Client } from "@kiwi/ai";
import { resolveResearchModelConfig, type AiModelRegistry } from "@kiwi/ai/models";
import { type ApiError } from "@kiwi/contracts/errors";
import { type DatabaseError } from "@kiwi/db/effect";
import * as Effect from "effect/Effect";
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
}): Effect.Effect<RequiredResearchClient, DatabaseError | ApiError | Error, AiModelRegistry | AiClientFactory> {
    return Effect.gen(function* () {
        const resolvedModels = yield* resolveResearchModelConfig({
            organizationId: options.organizationId,
            requestedTextModelId: options.requestedModelId,
        });
        const client = yield* makeAiClient(resolvedModels.config);
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
