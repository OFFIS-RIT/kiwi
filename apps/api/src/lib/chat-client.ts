import { buildAdapter, buildEmbeddingAdapter, getClient } from "@kiwi/ai";
import { env } from "../env";

export function getRequiredResearchClient() {
    const client = getClient({
        text: buildAdapter(
            env.AI_TEXT_ADAPTER,
            env.AI_TEXT_MODEL,
            env.AI_TEXT_KEY,
            env.AI_TEXT_URL,
            env.AI_TEXT_RESOURCE_NAME
        ),
        subagent: buildAdapter(
            env.AI_TEXT_ADAPTER,
            env.AI_SUBAGENT_MODEL ?? env.AI_TEXT_MODEL,
            env.AI_TEXT_KEY,
            env.AI_TEXT_URL,
            env.AI_TEXT_RESOURCE_NAME
        ),
        embedding: buildEmbeddingAdapter(
            env.AI_EMBEDDING_ADAPTER,
            env.AI_EMBEDDING_MODEL,
            env.AI_EMBEDDING_KEY,
            env.AI_EMBEDDING_URL,
            env.AI_EMBEDDING_RESOURCE_NAME
        ),
    });

    if (!client.text || !client.embedding) {
        throw new Error("Text and embedding models are required");
    }

    return {
        ...client,
        text: client.text,
        embedding: client.embedding,
    };
}

export type RequiredResearchClient = ReturnType<typeof getRequiredResearchClient>;
