import type { JSONObject, JSONValue, TranscriptionModelV3, TranscriptionModelV3CallOptions } from "@ai-sdk/provider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { withAiSlotEffect, type AICapability, type AiSlotError } from "./concurrency";

type OpenAICompatibleTranscriptionStyle = "openai" | "openrouter";

type OpenAICompatibleTranscriptionOptions = {
    model: string;
    apiKey: string;
    baseURL: string;
    provider?: string;
    fetch?: typeof globalThis.fetch;
    style?: OpenAICompatibleTranscriptionStyle;
    capability?: Extract<AICapability, "audio" | "video">;
};

type TranscriptionGenerateResult = Awaited<ReturnType<TranscriptionModelV3["doGenerate"]>>;

type TranscriptionSegment = TranscriptionGenerateResult["segments"][number];

type TranscriptionProviderOptions = {
    language?: string;
    prompt?: string;
    temperature?: number;
    timestampGranularities?: string[];
    provider?: JSONObject;
    responseFormat?: string;
    chunkingStrategy?: string;
};

export class TranscriptionResponseError extends Schema.TaggedErrorClass<TranscriptionResponseError>()(
    "TranscriptionResponseError",
    {
        message: Schema.String,
        status: Schema.Number,
        statusText: Schema.String,
        body: Schema.String,
    }
) {}

export class TranscriptionParseError extends Schema.TaggedErrorClass<TranscriptionParseError>()(
    "TranscriptionParseError",
    {
        message: Schema.String,
        cause: Schema.Unknown,
    }
) {}

export type TranscriptionError = AiSlotError | TranscriptionResponseError | TranscriptionParseError;

type RawTranscriptionResponse = JSONObject & {
    text?: JSONValue;
    language?: JSONValue;
    duration?: JSONValue;
    segments?: JSONValue;
    words?: JSONValue;
    usage?: JSONValue;
};

const PROVIDER_OPTION_KEYS = ["openaiAPI", "openai", "openrouter", "vllm"] as const;

export class OpenAICompatibleTranscriptionModel implements TranscriptionModelV3 {
    readonly specificationVersion = "v3";
    readonly provider: string;
    readonly modelId: string;

    private readonly apiKey: string;
    private readonly baseURL: string;
    private readonly fetch: typeof globalThis.fetch;
    private readonly style: OpenAICompatibleTranscriptionStyle;
    private readonly capability: Extract<AICapability, "audio" | "video">;

    constructor(options: OpenAICompatibleTranscriptionOptions) {
        this.provider = options.provider ?? "openaiAPI.transcription";
        this.modelId = options.model;
        this.apiKey = options.apiKey;
        this.baseURL = options.baseURL;
        this.fetch = options.fetch ?? globalThis.fetch;
        this.style = options.style ?? inferTranscriptionStyle(options.baseURL);
        this.capability = options.capability ?? "audio";
    }

    doGenerate(options: TranscriptionModelV3CallOptions): Promise<TranscriptionGenerateResult> {
        return Effect.runPromise(
            this.style === "openrouter"
                ? this.generateOpenRouterTranscription(options)
                : this.generateOpenAITranscription(options)
        );
    }

    private generateOpenAITranscription(
        options: TranscriptionModelV3CallOptions
    ): Effect.Effect<TranscriptionGenerateResult, TranscriptionError> {
        return Effect.gen({ self: this }, function* () {
            const currentDate = new Date();
            const providerOptions = readTranscriptionProviderOptions(options.providerOptions);
            const responseFormat = getOpenAIResponseFormat(this.modelId, providerOptions.responseFormat);
            const formData = new FormData();
            const audioBytes = toUint8Array(options.audio);
            const mediaType = normalizeAudioMediaType(options.mediaType);
            const extension = audioFormatFromMediaType(mediaType);

            formData.append("model", this.modelId);
            formData.append("file", new File([toArrayBuffer(audioBytes)], `audio.${extension}`, { type: mediaType }));
            formData.append("response_format", responseFormat);

            if (responseFormat === "diarized_json") {
                formData.append("chunking_strategy", providerOptions.chunkingStrategy ?? "auto");
            } else {
                if (providerOptions.prompt) {
                    formData.append("prompt", providerOptions.prompt);
                }
                if (responseFormat === "verbose_json" && providerOptions.timestampGranularities?.length) {
                    for (const granularity of providerOptions.timestampGranularities) {
                        formData.append("timestamp_granularities[]", granularity);
                    }
                }
            }

            if (providerOptions.language) {
                formData.append("language", providerOptions.language);
            }
            if (providerOptions.temperature !== undefined) {
                formData.append("temperature", String(providerOptions.temperature));
            }

            const response = yield* withAiSlotEffect(this.capability, (signal) =>
                this.fetch(transcriptionURL(this.baseURL), {
                    method: "POST",
                    headers: buildHeaders(this.apiKey, options.headers),
                    body: formData,
                    signal: combineAbortSignals(signal, options.abortSignal),
                })
            );

            const rawResponse = yield* parseTranscriptionResponse(response, responseFormat);
            const { segments, speakers } = parseSegments(rawResponse);
            const text =
                readString(rawResponse.text) ??
                segments
                    .map((segment) => segment.text)
                    .join(" ")
                    .trim();
            const durationInSeconds = readNumber(rawResponse.duration) ?? readUsageDuration(rawResponse.usage);

            return {
                text,
                segments,
                language: normalizeLanguage(readString(rawResponse.language)),
                durationInSeconds,
                warnings: [],
                response: {
                    timestamp: currentDate,
                    modelId: this.modelId,
                    headers: Object.fromEntries(response.headers.entries()),
                    body: rawResponse,
                },
                providerMetadata: buildProviderMetadata(speakers, rawResponse.usage),
            };
        });
    }

    private generateOpenRouterTranscription(
        options: TranscriptionModelV3CallOptions
    ): Effect.Effect<TranscriptionGenerateResult, TranscriptionError> {
        return Effect.gen({ self: this }, function* () {
            const currentDate = new Date();
            const providerOptions = readTranscriptionProviderOptions(options.providerOptions);
            const mediaType = normalizeAudioMediaType(options.mediaType);
            const audioBytes = toUint8Array(options.audio);
            const body: JSONObject = {
                model: this.modelId,
                input_audio: {
                    data: Buffer.from(audioBytes).toString("base64"),
                    format: audioFormatFromMediaType(mediaType),
                },
            };

            if (providerOptions.language) {
                body.language = providerOptions.language;
            }
            if (providerOptions.temperature !== undefined) {
                body.temperature = providerOptions.temperature;
            }
            if (providerOptions.provider) {
                body.provider = providerOptions.provider;
            }

            const response = yield* withAiSlotEffect(this.capability, (signal) =>
                this.fetch(transcriptionURL(this.baseURL), {
                    method: "POST",
                    headers: {
                        ...buildHeaders(this.apiKey, options.headers),
                        "content-type": "application/json",
                    },
                    body: JSON.stringify(body),
                    signal: combineAbortSignals(signal, options.abortSignal),
                })
            );

            const rawResponse = yield* parseTranscriptionResponse(response);
            const { segments, speakers } = parseSegments(rawResponse);
            const text =
                readString(rawResponse.text) ??
                segments
                    .map((segment) => segment.text)
                    .join(" ")
                    .trim();
            const durationInSeconds = readUsageDuration(rawResponse.usage) ?? readNumber(rawResponse.duration);
            const fallbackSegments =
                segments.length === 0 && text && durationInSeconds !== undefined
                    ? [{ text, startSecond: 0, endSecond: durationInSeconds }]
                    : segments;

            return {
                text,
                segments: fallbackSegments,
                language: normalizeLanguage(readString(rawResponse.language)),
                durationInSeconds,
                warnings: [],
                response: {
                    timestamp: currentDate,
                    modelId: this.modelId,
                    headers: Object.fromEntries(response.headers.entries()),
                    body: rawResponse,
                },
                providerMetadata: buildProviderMetadata(speakers, rawResponse.usage),
            };
        });
    }
}

export class UnsupportedTranscriptionModel implements TranscriptionModelV3 {
    readonly specificationVersion = "v3";
    readonly provider: string;
    readonly modelId: string;

    constructor(options: { provider: string; modelId: string; reason: string }) {
        this.provider = options.provider;
        this.modelId = options.modelId;
        this.reason = options.reason;
    }

    private readonly reason: string;

    doGenerate(): Promise<TranscriptionGenerateResult> {
        return Promise.reject(new Error(this.reason));
    }
}

function inferTranscriptionStyle(baseURL: string): OpenAICompatibleTranscriptionStyle {
    try {
        const url = new URL(baseURL);
        return url.hostname.endsWith("openrouter.ai") ? "openrouter" : "openai";
    } catch {
        return "openai";
    }
}

function transcriptionURL(baseURL: string): string {
    return `${baseURL.replace(/\/+$/u, "")}/audio/transcriptions`;
}

function buildHeaders(apiKey: string, headers: Record<string, string | undefined> | undefined): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers ?? {})) {
        if (value !== undefined) {
            result[key] = value;
        }
    }

    result.authorization = `Bearer ${apiKey}`;
    return result;
}

function parseTranscriptionResponse(
    response: Response,
    responseFormat = "json"
): Effect.Effect<RawTranscriptionResponse, TranscriptionResponseError | TranscriptionParseError> {
    return Effect.gen(function* () {
        const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (cause) =>
                new TranscriptionParseError({
                    message: "OpenAI-compatible transcription response body could not be read",
                    cause,
                }),
        });

        if (!response.ok) {
            const body = text.slice(0, 500);
            return yield* new TranscriptionResponseError({
                message: `OpenAI-compatible transcription request failed (${response.status} ${response.statusText}): ${body}`,
                status: response.status,
                statusText: response.statusText,
                body,
            });
        }

        if (!expectsJSONTranscriptionResponse(responseFormat)) {
            return { text };
        }

        return yield* Effect.try({
            try: () => JSON.parse(text) as RawTranscriptionResponse,
            catch: (cause) =>
                new TranscriptionParseError({
                    message: "OpenAI-compatible transcription response was not valid JSON",
                    cause,
                }),
        });
    });
}

function expectsJSONTranscriptionResponse(responseFormat: string): boolean {
    return responseFormat === "json" || responseFormat === "verbose_json" || responseFormat === "diarized_json";
}

function toUint8Array(audio: Uint8Array | string): Uint8Array {
    return typeof audio === "string" ? Buffer.from(audio, "base64") : audio;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

function normalizeAudioMediaType(mediaType: string | undefined): string {
    const normalized = mediaType?.split(";")[0]?.trim().toLowerCase();
    return normalized &&
        (normalized.startsWith("audio/") || normalized.startsWith("video/") || normalized === "application/ogg")
        ? normalized
        : "audio/wav";
}

function audioFormatFromMediaType(mediaType: string): string {
    switch (mediaType) {
        case "audio/mpeg":
        case "audio/mp3":
            return "mp3";
        case "audio/mp4":
        case "audio/m4a":
        case "audio/x-m4a":
            return "m4a";
        case "audio/wave":
        case "audio/wav":
        case "audio/x-wav":
            return "wav";
        case "audio/ogg":
        case "application/ogg":
            return "ogg";
        case "audio/flac":
        case "audio/x-flac":
            return "flac";
        case "audio/aac":
            return "aac";
        case "audio/webm":
        case "video/webm":
            return "webm";
        case "video/mp4":
            return "mp4";
        default:
            return (
                mediaType
                    .split("/")
                    .at(-1)
                    ?.replace(/[^a-z0-9]/giu, "") || "wav"
            );
    }
}

function getOpenAIResponseFormat(modelId: string, configured: string | undefined): string {
    if (configured) {
        return configured;
    }

    if (modelId.includes("transcribe-diarize")) {
        return "diarized_json";
    }

    if (modelId === "gpt-4o-transcribe" || modelId.startsWith("gpt-4o-transcribe-")) {
        return "json";
    }

    if (modelId === "gpt-4o-mini-transcribe" || modelId.startsWith("gpt-4o-mini-transcribe-")) {
        return "json";
    }

    return "verbose_json";
}

function readTranscriptionProviderOptions(
    providerOptions: TranscriptionModelV3CallOptions["providerOptions"]
): TranscriptionProviderOptions {
    const raw = PROVIDER_OPTION_KEYS.map((key) => providerOptions?.[key]).find(isJSONObject) ?? {};

    return {
        language: readString(raw.language),
        prompt: readString(raw.prompt),
        temperature: readNumber(raw.temperature),
        timestampGranularities: readStringArray(raw.timestampGranularities),
        provider: isJSONObject(raw.provider) ? raw.provider : undefined,
        responseFormat: readString(raw.responseFormat),
        chunkingStrategy: readString(raw.chunkingStrategy),
    };
}

function parseSegments(rawResponse: RawTranscriptionResponse): {
    segments: TranscriptionSegment[];
    speakers: Array<string | null>;
} {
    const segmentResult = parseTimedItems(rawResponse.segments, ["text"]);
    if (segmentResult.segments.length > 0) {
        return segmentResult;
    }

    const wordResult = parseTimedItems(rawResponse.words, ["word", "text"]);
    if (wordResult.segments.length > 0) {
        return wordResult;
    }

    return { segments: [], speakers: [] };
}

function parseTimedItems(
    value: JSONValue | undefined,
    textKeys: string[]
): {
    segments: TranscriptionSegment[];
    speakers: Array<string | null>;
} {
    if (!Array.isArray(value)) {
        return { segments: [], speakers: [] };
    }

    const segments: TranscriptionSegment[] = [];
    const speakers: Array<string | null> = [];

    for (const rawItem of value) {
        if (!isJSONObject(rawItem)) {
            continue;
        }

        const text = readFirstString(rawItem, textKeys);
        const startSecond = readSegmentTime(rawItem, ["start", "startSecond", "start_time"]);
        const endSecond = readSegmentTime(rawItem, ["end", "endSecond", "end_time"]);

        if (!text || startSecond === undefined || endSecond === undefined) {
            continue;
        }

        segments.push({ text, startSecond, endSecond });
        speakers.push(readSpeaker(rawItem));
    }

    return { segments, speakers };
}

function readFirstString(value: JSONObject, keys: string[]): string | undefined {
    for (const key of keys) {
        const text = readString(value[key]);
        if (text) {
            return text;
        }
    }

    return undefined;
}

function readSegmentTime(value: JSONObject, keys: string[]): number | undefined {
    for (const key of keys) {
        const seconds = readNumber(value[key]);
        if (seconds !== undefined) {
            return seconds;
        }
    }

    return undefined;
}

function readSpeaker(value: JSONObject): string | null {
    return (
        readString(value.speaker) ??
        readString(value.speaker_label) ??
        readString(value.speakerLabel) ??
        readString(value.speaker_id) ??
        readString(value.speakerId) ??
        null
    );
}

function readUsageDuration(value: JSONValue | undefined): number | undefined {
    return isJSONObject(value) ? readNumber(value.seconds) : undefined;
}

function normalizeLanguage(language: string | undefined): string | undefined {
    if (!language) {
        return undefined;
    }

    const lower = language.toLowerCase();
    const languageMap: Record<string, string> = {
        english: "en",
        german: "de",
        french: "fr",
        spanish: "es",
        italian: "it",
        portuguese: "pt",
        dutch: "nl",
        japanese: "ja",
        chinese: "zh",
    };

    return languageMap[lower] ?? lower;
}

function buildProviderMetadata(
    speakers: Array<string | null>,
    usage: JSONValue | undefined
): Record<string, JSONObject> | undefined {
    if (speakers.length === 0 && usage === undefined) {
        return undefined;
    }

    return {
        kiwi: {
            speakers,
            ...(usage !== undefined ? { usage } : {}),
        },
    };
}

function combineAbortSignals(primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal {
    if (!secondary) {
        return primary;
    }
    if (primary.aborted) {
        return primary;
    }
    if (secondary.aborted) {
        return secondary;
    }
    return AbortSignal.any([primary, secondary]);
}

function readString(value: JSONValue | undefined): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed !== "" ? trimmed : undefined;
}

function readNumber(value: JSONValue | undefined): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
}

function readStringArray(value: JSONValue | undefined): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const strings = value
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => item.trim());
    return strings.length > 0 ? strings : undefined;
}

function isJSONObject(value: unknown): value is JSONObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
