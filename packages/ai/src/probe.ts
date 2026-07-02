import { APICallError } from "@ai-sdk/provider";
import type { ModelTestResult } from "@kiwi/contracts/routes";
import type { AiModelAdapter, AiModelType } from "@kiwi/db/tables/models";
// Namespace import: test files mock the "ai" module with partial export sets,
// and named imports fail link-time validation against those mocks.
import * as ai from "ai";
import { buildAdapter, buildEmbeddingAdapter } from "./chat";
import { getClient, type EmbeddingAdapter } from "./index";
import type { ModelCredentials } from "./models";

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_OUTPUT_TOKENS = 16;
const PROBE_TEXT = "ping";
const ERROR_MESSAGE_MAX_LENGTH = 300;

export type ModelProbeInput = {
    type: AiModelType;
    adapter: AiModelAdapter;
    providerModel: string;
    credentials: ModelCredentials;
};

/**
 * Runs a minimal, type-appropriate request against the provider to verify the
 * supplied configuration without persisting anything. Never throws for
 * provider failures; those are classified into a ModelTestResult.
 */
export async function probeModelConfiguration(
    input: ModelProbeInput,
    options?: { timeoutMs?: number }
): Promise<ModelTestResult> {
    const abortSignal = AbortSignal.timeout(options?.timeoutMs ?? PROBE_TIMEOUT_MS);

    try {
        await runProbeRequest(input, abortSignal);
        return { ok: true };
    } catch (error) {
        return classifyModelProbeError(error);
    }
}

async function runProbeRequest(input: ModelProbeInput, abortSignal: AbortSignal): Promise<void> {
    const { adapter, providerModel, credentials } = input;

    switch (input.type) {
        case "embedding": {
            const client = getClient({
                embedding: buildEmbeddingAdapter(
                    adapter as EmbeddingAdapter["type"],
                    providerModel,
                    credentials.apiKey,
                    credentials.url,
                    credentials.resourceName
                ),
            });
            await ai.embed({ model: client.embedding!, value: PROBE_TEXT, maxRetries: 0, abortSignal });
            return;
        }
        // Video models are transcription endpoints in this system (see
        // createTranscriptionModel), and those accept audio payloads, so the
        // silent WAV works as a probe for both types.
        case "audio":
        case "video": {
            const transcriptionAdapter = buildAdapter(
                adapter,
                providerModel,
                credentials.apiKey,
                credentials.url,
                credentials.resourceName
            );
            const client = getClient(
                input.type === "audio" ? { audio: transcriptionAdapter } : { video: transcriptionAdapter }
            );
            const model = (input.type === "audio" ? client.audio : client.video)!;
            // doGenerate directly instead of ai.transcribe: the wrapper only
            // adds retries, which the probe disables anyway.
            await model.doGenerate({
                audio: buildProbeWav(),
                mediaType: "audio/wav",
                abortSignal,
            });
            return;
        }
        // text, subagent, extract, and image models are all chat-completion
        // language models here (image means multimodal understanding, see
        // getClient), so a tiny text completion probes each of them.
        default: {
            const client = getClient({
                text: buildAdapter(
                    adapter,
                    providerModel,
                    credentials.apiKey,
                    credentials.url,
                    credentials.resourceName
                ),
            });
            await ai.generateText({
                model: client.text!,
                prompt: PROBE_TEXT,
                maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
                maxRetries: 0,
                abortSignal,
            });
        }
    }
}

export function classifyModelProbeError(error: unknown): ModelTestResult & { ok: false } {
    const message = extractErrorMessage(error);
    const statusCode = extractStatusCode(error);

    if (statusCode === 401 || statusCode === 403) {
        return { ok: false, reason: "auth", message };
    }

    if (statusCode === 404) {
        return { ok: false, reason: "not_found", message };
    }

    if (statusCode !== undefined) {
        return { ok: false, reason: "unknown", message };
    }

    if (isUnreachableError(error)) {
        return { ok: false, reason: "unreachable", message };
    }

    return { ok: false, reason: "unknown", message };
}

function extractStatusCode(error: unknown): number | undefined {
    if (APICallError.isInstance(error)) {
        return error.statusCode;
    }

    // OpenAICompatibleTranscriptionModel throws plain errors of the form
    // "... transcription request failed (401 Unauthorized): ...".
    if (error instanceof Error) {
        const match = /transcription request failed \((\d{3}) /.exec(error.message);
        if (match) {
            return Number(match[1]);
        }
    }

    return undefined;
}

function isUnreachableError(error: unknown): boolean {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return true;
    }

    if (!(error instanceof Error)) {
        return false;
    }

    if (APICallError.isInstance(error) && error.statusCode === undefined) {
        return true;
    }

    const cause = error.cause;
    const causeCode =
        cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
            ? cause.code
            : undefined;
    if (causeCode && ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(causeCode)) {
        return true;
    }

    return /fetch failed|unable to connect|network (error|failure|request failed)|socket|timed? ?out/i.test(
        error.message
    );
}

function extractErrorMessage(error: unknown): string {
    const message = APICallError.isInstance(error)
        ? (extractResponseBodyMessage(error.responseBody) ?? error.message)
        : error instanceof Error
          ? error.message
          : String(error);
    const normalized = message.replace(/\s+/g, " ").trim();

    return normalized.length > ERROR_MESSAGE_MAX_LENGTH
        ? `${normalized.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`
        : normalized;
}

function extractResponseBodyMessage(responseBody: string | undefined): string | undefined {
    if (!responseBody) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(responseBody) as { error?: { message?: unknown }; message?: unknown };
        const message = parsed.error?.message ?? parsed.message;
        return typeof message === "string" && message.trim() ? message : undefined;
    } catch {
        return undefined;
    }
}

// Minimal valid WAV (0.5 s of 8 kHz mono 16-bit silence) so transcription
// probes send a payload every provider accepts without shipping a fixture.
export function buildProbeWav(): Uint8Array {
    const sampleRate = 8_000;
    const sampleCount = sampleRate / 2;
    const dataSize = sampleCount * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeAscii = (offset: number, text: string) => {
        for (let index = 0; index < text.length; index += 1) {
            view.setUint8(offset + index, text.charCodeAt(index));
        }
    };

    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, dataSize, true);

    return new Uint8Array(buffer);
}
