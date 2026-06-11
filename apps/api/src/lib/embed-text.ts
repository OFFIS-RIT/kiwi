import { embed, type EmbeddingModel } from "ai";
import { withAiSlot } from "@kiwi/ai";

export async function embedText(model: EmbeddingModel, value: string) {
    const { embedding } = await withAiSlot("embedding", () =>
        embed({
            model,
            value,
        })
    );

    return embedding;
}
