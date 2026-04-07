import type { Adapter, EmbeddingAdapter } from "@kiwi/ai";

export function buildAdapter(
    type: "openai" | "azure" | "anthropic" | "openaiAPI",
    model: string,
    key: string,
    url?: string,
    resourceName?: string
): Adapter {
    switch (type) {
        case "openai":
            return { type, model, credentials: { apiKey: key } };
        case "anthropic":
            return { type, model, credentials: { apiKey: key } };
        case "azure":
            return { type, model, credentials: { resourceName: resourceName!, apiKey: key } };
        case "openaiAPI":
            return { type, model, credentials: { apiKey: key, url: url! } };
    }
}

export function buildEmbeddingAdapter(
    type: "openai" | "azure" | "openaiAPI",
    model: string,
    key: string,
    url?: string,
    resourceName?: string
): EmbeddingAdapter {
    switch (type) {
        case "openai":
            return { type, model, credentials: { apiKey: key } };
        case "azure":
            return { type, model, credentials: { resourceName: resourceName!, apiKey: key } };
        case "openaiAPI":
            return { type, model, credentials: { apiKey: key, url: url! } };
    }
}
