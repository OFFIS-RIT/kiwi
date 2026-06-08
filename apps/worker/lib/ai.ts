import { buildAdapter, buildEmbeddingAdapter } from "@kiwi/ai";
import { env } from "../env";

export { buildAdapter, buildEmbeddingAdapter };

type AdapterName = Parameters<typeof buildAdapter>[0];

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
    return buildOptionalTranscriptionAdapter("AI_AUDIO", {
        adapter: env.AI_AUDIO_ADAPTER,
        model: env.AI_AUDIO_MODEL,
        key: env.AI_AUDIO_KEY,
        url: env.AI_AUDIO_URL,
        resourceName: env.AI_AUDIO_RESOURCE_NAME,
    });
}

export function buildVideoAdapter() {
    return buildOptionalTranscriptionAdapter("AI_VIDEO", {
        adapter: env.AI_VIDEO_ADAPTER,
        model: env.AI_VIDEO_MODEL,
        key: env.AI_VIDEO_KEY,
        url: env.AI_VIDEO_URL,
        resourceName: env.AI_VIDEO_RESOURCE_NAME,
    });
}

function buildOptionalTranscriptionAdapter(
    prefix: "AI_AUDIO" | "AI_VIDEO",
    config: {
        adapter?: string;
        model?: string;
        key?: string;
        url?: string;
        resourceName?: string;
    }
) {
    const adapter = normalizeOptionalString(config.adapter);
    const model = normalizeOptionalString(config.model);
    const key = normalizeOptionalString(config.key);
    const url = normalizeOptionalString(config.url);
    const resourceName = normalizeOptionalString(config.resourceName);

    const hasConfig = Boolean(adapter || model || key || url || resourceName);
    if (!hasConfig) {
        return undefined;
    }

    if (!adapter || !model || !key) {
        throw new Error(`${prefix}_ADAPTER, ${prefix}_MODEL, and ${prefix}_KEY must be set together`);
    }

    if (adapter === "anthropic") {
        throw new Error(`${prefix}_ADAPTER=anthropic is not supported for transcription`);
    }

    if (!isSupportedTranscriptionAdapter(adapter)) {
        throw new Error(`${prefix}_ADAPTER=${adapter} is not supported for transcription`);
    }

    if (adapter === "azure" && !resourceName) {
        throw new Error(`${prefix}_RESOURCE_NAME is required when ${prefix}_ADAPTER is azure`);
    }

    if (adapter === "openaiAPI" && !url) {
        throw new Error(`${prefix}_URL is required when ${prefix}_ADAPTER is openaiAPI`);
    }

    return buildAdapter(adapter, model, key, url, resourceName);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

function isSupportedTranscriptionAdapter(value: string): value is AdapterName {
    return value === "openai" || value === "azure" || value === "openaiAPI";
}
