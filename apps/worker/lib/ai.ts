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

export function buildAudioAdapter() {
    const hasAudioConfig = Boolean(
        env.AI_AUDIO_ADAPTER || env.AI_AUDIO_MODEL || env.AI_AUDIO_KEY || env.AI_AUDIO_URL || env.AI_AUDIO_RESOURCE_NAME
    );

    if (!hasAudioConfig) {
        return undefined;
    }

    if (!env.AI_AUDIO_ADAPTER || !env.AI_AUDIO_MODEL || !env.AI_AUDIO_KEY) {
        return undefined;
    }

    if (env.AI_AUDIO_ADAPTER === "azure" && !env.AI_AUDIO_RESOURCE_NAME) {
        return undefined;
    }

    if (env.AI_AUDIO_ADAPTER === "openaiAPI" && !env.AI_AUDIO_URL) {
        return undefined;
    }

    return buildAdapter(
        env.AI_AUDIO_ADAPTER,
        env.AI_AUDIO_MODEL,
        env.AI_AUDIO_KEY,
        env.AI_AUDIO_URL,
        env.AI_AUDIO_RESOURCE_NAME
    );
}

export function buildVideoAdapter() {
    const hasVideoConfig = Boolean(
        env.AI_VIDEO_ADAPTER || env.AI_VIDEO_MODEL || env.AI_VIDEO_KEY || env.AI_VIDEO_URL || env.AI_VIDEO_RESOURCE_NAME
    );

    if (!hasVideoConfig) {
        return undefined;
    }

    if (!env.AI_VIDEO_ADAPTER || !env.AI_VIDEO_MODEL || !env.AI_VIDEO_KEY) {
        return undefined;
    }

    if (env.AI_VIDEO_ADAPTER === "azure" && !env.AI_VIDEO_RESOURCE_NAME) {
        return undefined;
    }

    if (env.AI_VIDEO_ADAPTER === "openaiAPI" && !env.AI_VIDEO_URL) {
        return undefined;
    }

    return buildAdapter(
        env.AI_VIDEO_ADAPTER,
        env.AI_VIDEO_MODEL,
        env.AI_VIDEO_KEY,
        env.AI_VIDEO_URL,
        env.AI_VIDEO_RESOURCE_NAME
    );
}
