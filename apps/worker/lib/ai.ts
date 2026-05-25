import { buildAdapter, buildEmbeddingAdapter } from "@kiwi/ai";
import { env } from "../env";

export { buildAdapter, buildEmbeddingAdapter };

function buildTextAdapter() {
    return buildAdapter(
        env.AI_TEXT_ADAPTER,
        env.AI_TEXT_MODEL,
        env.AI_TEXT_KEY,
        env.AI_TEXT_URL,
        env.AI_TEXT_RESOURCE_NAME
    );
}

export function buildWorkerTextAdapter() {
    const hasExtractConfig = Boolean(
        env.AI_EXTRACT_ADAPTER ||
            env.AI_EXTRACT_MODEL ||
            env.AI_EXTRACT_KEY ||
            env.AI_EXTRACT_URL ||
            env.AI_EXTRACT_RESOURCE_NAME
    );

    if (!hasExtractConfig) {
        return buildTextAdapter();
    }

    if (!env.AI_EXTRACT_ADAPTER || !env.AI_EXTRACT_MODEL || !env.AI_EXTRACT_KEY) {
        throw new Error("AI_EXTRACT_ADAPTER, AI_EXTRACT_MODEL, and AI_EXTRACT_KEY must be set together");
    }

    if (env.AI_EXTRACT_ADAPTER === "azure" && !env.AI_EXTRACT_RESOURCE_NAME) {
        throw new Error("AI_EXTRACT_RESOURCE_NAME is required when AI_EXTRACT_ADAPTER is azure");
    }

    return buildAdapter(
        env.AI_EXTRACT_ADAPTER,
        env.AI_EXTRACT_MODEL,
        env.AI_EXTRACT_KEY,
        env.AI_EXTRACT_URL,
        env.AI_EXTRACT_RESOURCE_NAME
    );
}
