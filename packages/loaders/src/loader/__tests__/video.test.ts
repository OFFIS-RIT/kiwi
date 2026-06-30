import { describe, expect, test } from "bun:test";
import type { TranscriptionModelV4 } from "@ai-sdk/provider";
import { configureAIConcurrency } from "@kiwi/ai/lock";
import { MockTranscriptionModelV4 } from "ai/test";
import { BufferedGraphBinaryLoader } from "../factory";
import { VideoLoader } from "../video";

describe("VideoLoader", () => {
    test("formats video transcription output as transcript markdown", async () => {
        let capturedOptions: Parameters<TranscriptionModelV4["doGenerate"]>[0] | undefined;
        const model = new MockTranscriptionModelV4({
            doGenerate: async (options) => {
                capturedOptions = options;

                return buildTranscriptionResult({
                    text: "Video audio.",
                    segments: [
                        { text: "Video audio.", startSecond: 0, endSecond: 1 },
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
        const loader = new VideoLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(1, 2, 3))),
            model,
            mimeType: "video/mp4; codecs=avc1",
        });

        const transcript = await loader.getText();

        expect(capturedOptions?.mediaType).toBe("video/mp4");
        expect(transcript).toContain("# Video Transcript");
        expect(transcript).toContain("- Speaker: Speaker A");
        expect(transcript).toContain("- Speaker: Speaker unknown");
    });

    test("defaults unknown video MIME types to video/mp4", async () => {
        let capturedOptions: Parameters<TranscriptionModelV4["doGenerate"]>[0] | undefined;
        const model = new MockTranscriptionModelV4({
            doGenerate: async (options) => {
                capturedOptions = options;

                return buildTranscriptionResult({
                    text: "Video audio.",
                    segments: [{ text: "Video audio.", startSecond: 0, endSecond: 1 }],
                });
            },
        });
        const loader = new VideoLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(1, 2, 3))),
            model,
            mimeType: "application/octet-stream",
        });

        await loader.getText();

        expect(capturedOptions?.mediaType).toBe("video/mp4");
    });

    test("uses the video concurrency lane independently from audio", async () => {
        configureAIConcurrency({ audio: 1, video: 2 });

        let active = 0;
        let maxActive = 0;
        const model = new MockTranscriptionModelV4({
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
                new VideoLoader({
                    loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(1))),
                    model,
                    mimeType: "video/mp4",
                }).getText(),
                new VideoLoader({
                    loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(2))),
                    model,
                    mimeType: "video/mp4",
                }).getText(),
            ]);

            expect(maxActive).toBe(2);
        } finally {
            configureAIConcurrency({ audio: 64, video: 64 });
        }
    });

    test("rejects empty transcription output", async () => {
        const model = new MockTranscriptionModelV4({
            doGenerate: async () =>
                buildTranscriptionResult({
                    text: "   ",
                    segments: [],
                }),
        });
        const loader = new VideoLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(Uint8Array.of(1, 2, 3))),
            model,
            mimeType: "video/mp4",
        });

        await expect(loader.getText()).rejects.toThrow("Video transcription produced no text");
    });
});

function buildTranscriptionResult(
    options: Partial<Awaited<ReturnType<TranscriptionModelV4["doGenerate"]>>>
): Awaited<ReturnType<TranscriptionModelV4["doGenerate"]>> {
    return {
        text: options.text ?? "",
        segments: options.segments ?? [],
        language: "language" in options ? options.language : "en",
        durationInSeconds: "durationInSeconds" in options ? options.durationInSeconds : 2,
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
