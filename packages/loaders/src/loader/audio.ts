import type { JSONObject, TranscriptionModelV3 } from "@ai-sdk/provider";
import { audioTranscriptPrompt } from "@kiwi/ai/prompts/audio-transcript.prompt";
import { type AICapability, withAiSlot } from "@kiwi/ai/lock";
import type { GraphBinaryLoader, GraphLoader } from "../types";

const UNKNOWN_SPEAKER = "Speaker unknown";
const TRANSCRIPTION_PROVIDER_OPTIONS = {
    openai: {
        prompt: audioTranscriptPrompt,
        temperature: 0,
        timestampGranularities: ["segment"],
    },
    openaiAPI: {
        prompt: audioTranscriptPrompt,
        temperature: 0,
        timestampGranularities: ["segment"],
    },
    azure: {
        prompt: audioTranscriptPrompt,
        temperature: 0,
        timestampGranularities: ["segment"],
    },
};

type TranscriptionResult = Awaited<ReturnType<TranscriptionModelV3["doGenerate"]>>;
type MediaTranscriptCapability = Extract<AICapability, "audio" | "video">;

export type MediaTranscriptLoaderOptions = {
    loader: GraphBinaryLoader;
    model: TranscriptionModelV3;
    mimeType?: string | null;
    capability: MediaTranscriptCapability;
    title: string;
    emptyResultMessage: string;
};

export class AudioLoader implements GraphLoader {
    constructor(
        private options: {
            loader: GraphBinaryLoader;
            model: TranscriptionModelV3;
            mimeType?: string | null;
        }
    ) {}

    async getText(): Promise<string> {
        return loadMediaTranscript({
            ...this.options,
            capability: "audio",
            title: "Audio Transcript",
            emptyResultMessage: "Audio transcription produced no text",
        });
    }
}

export async function loadMediaTranscript(options: MediaTranscriptLoaderOptions): Promise<string> {
    const content = await options.loader.getBinary();
    const result = await withAiSlot(options.capability, async () =>
        options.model.doGenerate({
            audio: new Uint8Array(content),
            mediaType: normalizeTranscriptMediaType(options.mimeType, options.capability),
            providerOptions: TRANSCRIPTION_PROVIDER_OPTIONS,
        })
    );

    if (!result.text.trim() && result.segments.length === 0) {
        throw new Error(options.emptyResultMessage);
    }

    return formatTranscript(result, options.title);
}

function formatTranscript(result: TranscriptionResult, title: string): string {
    const lines: string[] = [`# ${title}`];

    const metadata: string[] = [];
    if (result.language) {
        metadata.push(`- Language: ${result.language}`);
    }
    if (result.durationInSeconds !== undefined) {
        metadata.push(`- Duration: ${formatTimestamp(result.durationInSeconds)}`);
    }

    if (metadata.length > 0) {
        lines.push("", ...metadata);
    }

    const speakers = readSpeakers(result.providerMetadata);
    const segments =
        result.segments.length > 0
            ? result.segments
            : [
                  {
                      text: result.text,
                      startSecond: undefined,
                      endSecond: undefined,
                  },
              ];

    segments.forEach((segment, index) => {
        const speaker = speakers[index] || UNKNOWN_SPEAKER;
        const time =
            segment.startSecond !== undefined && segment.endSecond !== undefined
                ? `${formatTimestamp(segment.startSecond)} --> ${formatTimestamp(segment.endSecond)}`
                : "unknown";

        lines.push("", `## Segment ${index + 1}`, `- Time: ${time}`, `- Speaker: ${speaker}`, "", segment.text.trim());
    });

    return lines.join("\n").trim();
}

function readSpeakers(metadata: Record<string, JSONObject> | undefined): string[] {
    const speakers = metadata?.kiwi?.speakers;
    if (!Array.isArray(speakers)) {
        return [];
    }

    return speakers.map((speaker) => {
        if (typeof speaker !== "string") {
            return UNKNOWN_SPEAKER;
        }

        const trimmed = speaker.trim();
        return trimmed ? trimmed : UNKNOWN_SPEAKER;
    });
}

function normalizeTranscriptMediaType(
    mimeType: string | null | undefined,
    capability: MediaTranscriptCapability
): string {
    const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
    return normalized &&
        (normalized.startsWith("audio/") || normalized.startsWith("video/") || normalized === "application/ogg")
        ? normalized
        : capability === "video"
          ? "video/mp4"
          : "audio/wav";
}

function formatTimestamp(totalSeconds: number): string {
    const totalMilliseconds = Math.round(Math.max(0, totalSeconds) * 1000);
    const hours = Math.floor(totalMilliseconds / 3_600_000);
    const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
    const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
    const milliseconds = totalMilliseconds % 1000;

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${String(milliseconds).padStart(3, "0")}`;
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}
