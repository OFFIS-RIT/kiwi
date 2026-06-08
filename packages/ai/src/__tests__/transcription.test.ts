import { describe, expect, test } from "bun:test";
import { getClient } from "../index";
import { OpenAICompatibleTranscriptionModel } from "../transcription";

describe("OpenAICompatibleTranscriptionModel", () => {
    test("uses OpenAI-compatible multipart requests for vLLM-style endpoints", async () => {
        let capturedURL = "";
        let capturedInit: RequestInit | undefined;
        const model = new OpenAICompatibleTranscriptionModel({
            model: "openai/whisper-large-v3",
            apiKey: "test-key",
            baseURL: "http://localhost:8000/v1",
            fetch: async (input, init) => {
                capturedURL = String(input);
                capturedInit = init;

                return Response.json({
                    text: "Hello world",
                    language: "english",
                    duration: 1.5,
                    segments: [{ text: "Hello world", start: 0, end: 1.5 }],
                });
            },
        });

        const result = await model.doGenerate({
            audio: Uint8Array.of(1, 2, 3),
            mediaType: "audio/mpeg",
            providerOptions: {
                openaiAPI: {
                    prompt: "Expected vocabulary: Kiwi",
                    timestampGranularities: ["segment"],
                },
            },
        });

        const body = capturedInit?.body;
        expect(capturedURL).toBe("http://localhost:8000/v1/audio/transcriptions");
        expect(capturedInit?.method).toBe("POST");
        expect(capturedInit?.headers).toMatchObject({ authorization: "Bearer test-key" });
        expect(body).toBeInstanceOf(FormData);
        expect((body as FormData).get("model")).toBe("openai/whisper-large-v3");
        expect((body as FormData).get("response_format")).toBe("verbose_json");
        expect((body as FormData).get("prompt")).toBe("Expected vocabulary: Kiwi");
        expect((body as FormData).get("timestamp_granularities[]")).toBe("segment");
        expect(result.language).toBe("en");
        expect(result.segments).toEqual([{ text: "Hello world", startSecond: 0, endSecond: 1.5 }]);
    });

    test("decodes base64 audio and preserves video media type for multipart endpoints", async () => {
        let capturedBody: BodyInit | null | undefined;
        const model = new OpenAICompatibleTranscriptionModel({
            model: "openai/whisper-large-v3",
            apiKey: "test-key",
            baseURL: "http://localhost:8000/v1/",
            fetch: async (_input, init) => {
                capturedBody = init?.body;

                return Response.json({
                    text: "Video transcript",
                });
            },
        });

        await model.doGenerate({
            audio: Buffer.from(Uint8Array.of(4, 5, 6)).toString("base64"),
            mediaType: "video/mp4; codecs=avc1",
            providerOptions: {
                openaiAPI: {
                    language: " de ",
                    timestampGranularities: [" segment ", ""],
                },
            },
        });

        const body = capturedBody as FormData;
        const file = body.get("file");

        expect(body).toBeInstanceOf(FormData);
        expect(body.get("language")).toBe("de");
        expect(body.get("timestamp_granularities[]")).toBe("segment");
        expect(file).toBeInstanceOf(File);
        expect((file as File).name).toBe("audio.mp4");
        expect((file as File).type).toBe("video/mp4");
        expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(Uint8Array.of(4, 5, 6));
    });

    test("preserves application/ogg media type for multipart endpoints", async () => {
        let capturedBody: BodyInit | null | undefined;
        const model = new OpenAICompatibleTranscriptionModel({
            model: "openai/whisper-large-v3",
            apiKey: "test-key",
            baseURL: "http://localhost:8000/v1/",
            fetch: async (_input, init) => {
                capturedBody = init?.body;

                return Response.json({
                    text: "OGG transcript",
                });
            },
        });

        await model.doGenerate({
            audio: Uint8Array.of(7, 8, 9),
            mediaType: "application/ogg",
        });

        const file = (capturedBody as FormData).get("file");

        expect(file).toBeInstanceOf(File);
        expect((file as File).name).toBe("audio.ogg");
        expect((file as File).type).toBe("application/ogg");
    });

    test("uses diarized JSON for OpenAI diarization models", async () => {
        let capturedBody: BodyInit | null | undefined;
        const model = new OpenAICompatibleTranscriptionModel({
            model: "gpt-4o-transcribe-diarize",
            apiKey: "test-key",
            baseURL: "https://api.openai.com/v1",
            fetch: async (_input, init) => {
                capturedBody = init?.body;

                return Response.json({
                    text: "Hello world",
                    segments: [{ text: "Hello world", start: 0, end: 1.5, speaker: "Speaker A" }],
                });
            },
        });

        const result = await model.doGenerate({
            audio: Uint8Array.of(1, 2, 3),
            mediaType: "audio/wav",
            providerOptions: {
                openai: {
                    prompt: "This prompt is not sent for diarization models",
                },
            },
        });

        expect(capturedBody).toBeInstanceOf(FormData);
        expect((capturedBody as FormData).get("response_format")).toBe("diarized_json");
        expect((capturedBody as FormData).get("chunking_strategy")).toBe("auto");
        expect((capturedBody as FormData).get("prompt")).toBeNull();
        expect(result.providerMetadata?.kiwi?.speakers).toEqual(["Speaker A"]);
    });

    test("does not send timestamp granularity when the response format is JSON", async () => {
        let capturedBody: BodyInit | null | undefined;
        const model = new OpenAICompatibleTranscriptionModel({
            model: "gpt-4o-mini-transcribe",
            apiKey: "test-key",
            baseURL: "https://api.openai.com/v1",
            fetch: async (_input, init) => {
                capturedBody = init?.body;

                return Response.json({
                    text: "Hello world",
                });
            },
        });

        await model.doGenerate({
            audio: Uint8Array.of(1, 2, 3),
            mediaType: "audio/wav",
            providerOptions: {
                openai: {
                    timestampGranularities: ["segment"],
                },
            },
        });

        expect(capturedBody).toBeInstanceOf(FormData);
        expect((capturedBody as FormData).get("response_format")).toBe("json");
        expect((capturedBody as FormData).get("timestamp_granularities[]")).toBeNull();
    });

    test("accepts plain text transcription responses when text format is requested", async () => {
        let capturedBody: BodyInit | null | undefined;
        const model = new OpenAICompatibleTranscriptionModel({
            model: "openai/whisper-large-v3",
            apiKey: "test-key",
            baseURL: "http://localhost:8000/v1",
            fetch: async (_input, init) => {
                capturedBody = init?.body;

                return new Response("Plain transcript text", { status: 200 });
            },
        });

        const result = await model.doGenerate({
            audio: Uint8Array.of(1, 2, 3),
            mediaType: "audio/wav",
            providerOptions: {
                openaiAPI: {
                    responseFormat: "text",
                },
            },
        });

        expect((capturedBody as FormData).get("response_format")).toBe("text");
        expect(result.text).toBe("Plain transcript text");
        expect(result.segments).toEqual([]);
    });

    test("uses OpenRouter JSON requests for OpenRouter STT endpoints", async () => {
        let capturedURL = "";
        let capturedInit: RequestInit | undefined;
        const model = new OpenAICompatibleTranscriptionModel({
            model: "openai/whisper-1",
            apiKey: "test-key",
            baseURL: "https://openrouter.ai/api/v1",
            fetch: async (input, init) => {
                capturedURL = String(input);
                capturedInit = init;

                return Response.json({
                    text: "Hello from OpenRouter",
                    usage: {
                        seconds: 9.2,
                    },
                });
            },
        });

        const result = await model.doGenerate({
            audio: Uint8Array.of(1, 2, 3),
            mediaType: "audio/wav",
            providerOptions: {
                openaiAPI: {
                    language: "en",
                    temperature: 0,
                },
            },
        });

        expect(capturedURL).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
        expect(capturedInit?.method).toBe("POST");
        expect(capturedInit?.headers).toMatchObject({
            authorization: "Bearer test-key",
            "content-type": "application/json",
        });
        expect(JSON.parse(String(capturedInit?.body))).toEqual({
            model: "openai/whisper-1",
            input_audio: {
                data: "AQID",
                format: "wav",
            },
            language: "en",
            temperature: 0,
        });
        expect(result.text).toBe("Hello from OpenRouter");
        expect(result.durationInSeconds).toBe(9.2);
        expect(result.segments).toEqual([{ text: "Hello from OpenRouter", startSecond: 0, endSecond: 9.2 }]);
    });

    test("falls back to word timings when segment timings are unusable", async () => {
        const model = new OpenAICompatibleTranscriptionModel({
            model: "openai/whisper-large-v3",
            apiKey: "test-key",
            baseURL: "http://localhost:8000/v1",
            fetch: async () =>
                Response.json({
                    segments: [{ text: "Segment text without timestamps" }],
                    words: [
                        { word: " Hello ", start: "0", end: "0.4", speaker_label: " Speaker A " },
                        { text: "world", startSecond: 0.4, endSecond: 0.9 },
                    ],
                }),
        });

        const result = await model.doGenerate({
            audio: Uint8Array.of(1, 2, 3),
            mediaType: "audio/wav",
        });

        expect(result.text).toBe("Hello world");
        expect(result.segments).toEqual([
            { text: "Hello", startSecond: 0, endSecond: 0.4 },
            { text: "world", startSecond: 0.4, endSecond: 0.9 },
        ]);
        expect(result.providerMetadata?.kiwi?.speakers).toEqual(["Speaker A", null]);
    });

    test("surfaces non-OK and invalid JSON responses", async () => {
        const failingModel = new OpenAICompatibleTranscriptionModel({
            model: "openai/whisper-large-v3",
            apiKey: "test-key",
            baseURL: "http://localhost:8000/v1",
            fetch: async () => new Response("bad request body", { status: 400, statusText: "Bad Request" }),
        });
        await expect(
            failingModel.doGenerate({
                audio: Uint8Array.of(1),
                mediaType: "audio/wav",
            })
        ).rejects.toThrow("OpenAI-compatible transcription request failed (400 Bad Request): bad request body");

        const invalidJsonModel = new OpenAICompatibleTranscriptionModel({
            model: "openai/whisper-large-v3",
            apiKey: "test-key",
            baseURL: "http://localhost:8000/v1",
            fetch: async () => new Response("not json", { status: 200 }),
        });
        await expect(
            invalidJsonModel.doGenerate({
                audio: Uint8Array.of(1),
                mediaType: "audio/wav",
            })
        ).rejects.toThrow("OpenAI-compatible transcription response was not valid JSON");
    });

    test("defers unsupported Anthropic audio failures until transcription is attempted", async () => {
        const client = getClient({
            audio: {
                type: "anthropic",
                model: "claude-test",
                credentials: {
                    apiKey: "test-key",
                },
            },
        });

        expect(client.audio?.provider).toBe("anthropic.audio-transcription");
        await expect(
            client.audio?.doGenerate({
                audio: Uint8Array.of(1, 2, 3),
                mediaType: "audio/wav",
            })
        ).rejects.toThrow("AI audio transcription is not supported by anthropic");
    });

    test("defers unsupported Anthropic video failures until transcription is attempted", async () => {
        const client = getClient({
            video: {
                type: "anthropic",
                model: "claude-test",
                credentials: {
                    apiKey: "test-key",
                },
            },
        });

        expect(client.video?.provider).toBe("anthropic.video-transcription");
        await expect(
            client.video?.doGenerate({
                audio: Uint8Array.of(1, 2, 3),
                mediaType: "video/mp4",
            })
        ).rejects.toThrow("AI video transcription is not supported by anthropic");
    });
});
