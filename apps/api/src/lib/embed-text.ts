import * as Effect from "effect/Effect";
import { embed, type EmbeddingModel } from "ai";
import { withAiSlot } from "@kiwi/ai";

export function embedText(model: EmbeddingModel, value: string) {
    return Effect.gen(function* () {
        const { embedding } = yield* Effect.tryPromise(() =>
            withAiSlot("embedding", (signal) =>
                embed({
                    model,
                    value,
                    abortSignal: signal,
                })
            )
        );

        return embedding;
    });
}
