import { describe, expect, test } from "bun:test";
import { configureAIConcurrency } from "@kiwi/ai/lock";
import type { TranscriptionModelV3 } from "@ai-sdk/provider";
import { MockTranscriptionModelV3 } from "ai/test";
import { AudioLoader } from "../audio";
import { BufferedGraphBinaryLoader } from "../factory";

describe("AudioLoader", () => {
    test("formats transcription segments as markdown with speakers and timestamps", async () => {
        let capturedOptions: Parameters<TranscriptionModelV3["doGenerate"]>[0] | undefined;
        const model = new MockTranscriptionModelV3({
            doGenerate: async (options) => {
                capturedOptions = options;
                return buildTranscriptionResult({
                    text: "Hello there. Hi back.",
                    segments: [
                        { text: "Hello there.", startSecond: 0, endSecond: 1.25 },
                        { text: "Hi back.", startSecond: 1.5, endSecond: 2.75 },
                    ],
                    providerMetadata: {
                        kiwi: {
                            speakers: ["Alice", "Bob"],
                        },
                    },
                });
            },
        });
        const loader = new AudioLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(1, 2, 3))),
            model,
            mimeType: "audio/mpeg",
        });

        const transcript = await loader.getText();

        expect(capturedOptions?.mediaType).toBe("audio/mpeg");
        expect(transcript).toContain("# Audio Transcript");
        expect(transcript).toContain("- Duration: 00:00:02.750");
        expect(transcript).toContain("## Segment 1");
        expect(transcript).toContain("- Time: 00:00:00.000 --> 00:00:01.250");
        expect(transcript).toContain("- Speaker: Alice");
        expect(transcript).toContain("## Segment 2");
        expect(transcript).toContain("- Speaker: Bob");
    });

    test("formats text-only transcription output with unknown time and speaker", async () => {
        const model = new MockTranscriptionModelV3({
            doGenerate: async () =>
                buildTranscriptionResult({
                    text: "A transcript without provider segments.",
                    segments: [],
                    durationInSeconds: undefined,
                    language: undefined,
                }),
        });
        const loader = new AudioLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(1, 2, 3))),
            model,
            mimeType: "application/octet-stream",
        });

        await expect(loader.getText()).resolves.toBe(
            [
                "# Audio Transcript",
                "",
                "## Segment 1",
                "- Time: unknown",
                "- Speaker: Speaker unknown",
                "",
                "A transcript without provider segments.",
            ].join("\n")
        );
    });

    test("normalizes speaker metadata", async () => {
        let capturedOptions: Parameters<TranscriptionModelV3["doGenerate"]>[0] | undefined;
        const model = new MockTranscriptionModelV3({
            doGenerate: async (options) => {
                capturedOptions = options;

                return buildTranscriptionResult({
                    text: "Audio text.",
                    segments: [
                        { text: "Audio text.", startSecond: 0, endSecond: 1 },
                        { text: "No speaker metadata.", startSecond: 1, endSecond: 2 },
                    ],
                    providerMetadata: {
                        kiwi: {
                            speakers: [" Speaker A ", null],
                        },
                    },
                });
            },
        });
        const loader = new AudioLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(1, 2, 3))),
            model,
            mimeType: "audio/wav; charset=binary",
        });

        const transcript = await loader.getText();

        expect(capturedOptions?.mediaType).toBe("audio/wav");
        expect(transcript).toContain("- Speaker: Speaker A");
        expect(transcript).toContain("- Speaker: Speaker unknown");
    });

    test("preserves application/ogg media type for transcription", async () => {
        let capturedOptions: Parameters<TranscriptionModelV3["doGenerate"]>[0] | undefined;
        const model = new MockTranscriptionModelV3({
            doGenerate: async (options) => {
                capturedOptions = options;

                return buildTranscriptionResult({
                    text: "OGG audio.",
                    segments: [{ text: "OGG audio.", startSecond: 0, endSecond: 1 }],
                });
            },
        });
        const loader = new AudioLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(1, 2, 3))),
            model,
            mimeType: "application/ogg",
        });

        await loader.getText();

        expect(capturedOptions?.mediaType).toBe("application/ogg");
    });

    test("rejects empty transcription output", async () => {
        const model = new MockTranscriptionModelV3({
            doGenerate: async () =>
                buildTranscriptionResult({
                    text: "   ",
                    segments: [],
                }),
        });
        const loader = new AudioLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(1, 2, 3))),
            model,
            mimeType: "audio/wav",
        });

        await expect(loader.getText()).rejects.toThrow("Audio transcription produced no text");
    });

    test("uses the audio concurrency lane", async () => {
        configureAIConcurrency({ audio: 1 });

        let active = 0;
        let maxActive = 0;
        const model = new MockTranscriptionModelV3({
            doGenerate: async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await sleep(20);
                active -= 1;

                return buildTranscriptionResult({
                    text: "ok",
                    segments: [{ text: "ok", startSecond: 0, endSecond: 1 }],
                });
            },
        });

        try {
            await Promise.all([
                new AudioLoader({
                    loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(1))),
                    model,
                    mimeType: "audio/wav",
                }).getText(),
                new AudioLoader({
                    loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(2))),
                    model,
                    mimeType: "audio/wav",
                }).getText(),
            ]);

            expect(maxActive).toBe(1);
        } finally {
            configureAIConcurrency({ audio: 64 });
        }
    });
});

function buildTranscriptionResult(
    options: Partial<Awaited<ReturnType<TranscriptionModelV3["doGenerate"]>>>
): Awaited<ReturnType<TranscriptionModelV3["doGenerate"]>> {
    return {
        text: options.text ?? "",
        segments: options.segments ?? [],
        language: "language" in options ? options.language : "en",
        durationInSeconds: "durationInSeconds" in options ? options.durationInSeconds : 2.75,
        warnings: [],
        response: {
            timestamp: new Date("2026-01-01T00:00:00.000Z"),
            modelId: "mock-transcribe",
        },
        providerMetadata: options.providerMetadata,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
