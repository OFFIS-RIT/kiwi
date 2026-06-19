import * as Effect from "effect/Effect";
import { embed, type EmbeddingModel } from "ai";
import { withAiSlotEffect } from "@kiwi/ai/lock";

export const embedText = Effect.fn("embedText")(function* (model: EmbeddingModel, value: string) {
    const { embedding } = yield* withAiSlotEffect("embedding", (signal) =>
        embed({
            model,
            value,
            abortSignal: signal,
        })
    );

    return embedding;
});
