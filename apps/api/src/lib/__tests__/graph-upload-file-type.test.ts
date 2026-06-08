import { beforeEach, describe, expect, mock, test } from "bun:test";
import { API_ERROR_CODES } from "../../types";

const envMock = {
    AI_AUDIO_ADAPTER: undefined as "openai" | "azure" | "anthropic" | "openaiAPI" | undefined,
    AI_AUDIO_MODEL: undefined as string | undefined,
    AI_AUDIO_KEY: undefined as string | undefined,
    AI_AUDIO_URL: undefined as string | undefined,
    AI_AUDIO_RESOURCE_NAME: undefined as string | undefined,
    AI_VIDEO_ADAPTER: undefined as "openai" | "azure" | "anthropic" | "openaiAPI" | undefined,
    AI_VIDEO_MODEL: undefined as string | undefined,
    AI_VIDEO_KEY: undefined as string | undefined,
    AI_VIDEO_URL: undefined as string | undefined,
    AI_VIDEO_RESOURCE_NAME: undefined as string | undefined,
};

mock.module("../../env", () => ({
    env: envMock,
}));

const { inferSupportedUploadedFiles, unsupportedUploadResponse } = await import("../graph-upload-file-type");

describe("inferSupportedUploadedFiles", () => {
    beforeEach(() => {
        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: undefined,
            AI_AUDIO_MODEL: undefined,
            AI_AUDIO_KEY: undefined,
            AI_AUDIO_URL: undefined,
            AI_AUDIO_RESOURCE_NAME: undefined,
            AI_VIDEO_ADAPTER: undefined,
            AI_VIDEO_MODEL: undefined,
            AI_VIDEO_KEY: undefined,
            AI_VIDEO_URL: undefined,
            AI_VIDEO_RESOURCE_NAME: undefined,
        });
    });

    test("rejects audio uploads when audio transcription is not configured", () => {
        const result = inferSupportedUploadedFiles([{ file: new File([""], "meeting.mp3"), checksum: "a" }]);

        expect(result).toEqual({
            ok: false,
            fileName: "meeting.mp3",
            message: "Audio uploads require AI_AUDIO_ADAPTER, AI_AUDIO_MODEL, and AI_AUDIO_KEY",
        });
    });

    test("treats whitespace-only media config as missing", () => {
        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: " " as never,
            AI_AUDIO_MODEL: " ",
            AI_AUDIO_KEY: "\t",
            AI_AUDIO_URL: " ",
            AI_AUDIO_RESOURCE_NAME: " ",
        });

        const result = inferSupportedUploadedFiles([{ file: new File([""], "meeting.mp3"), checksum: "a" }]);

        expect(result).toEqual({
            ok: false,
            fileName: "meeting.mp3",
            message: "Audio uploads require AI_AUDIO_ADAPTER, AI_AUDIO_MODEL, and AI_AUDIO_KEY",
        });
    });

    test("rejects OpenAI-compatible video uploads without a URL", () => {
        Object.assign(envMock, {
            AI_VIDEO_ADAPTER: "openaiAPI",
            AI_VIDEO_MODEL: "openai/whisper-1",
            AI_VIDEO_KEY: "video-key",
        });

        const result = inferSupportedUploadedFiles([{ file: new File([""], "clip.mp4"), checksum: "v" }]);

        expect(result).toEqual({
            ok: false,
            fileName: "clip.mp4",
            message: "Video uploads require AI_VIDEO_URL when AI_VIDEO_ADAPTER is openaiAPI",
        });
    });

    test("rejects Anthropic media uploads because transcription is unsupported", () => {
        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "anthropic",
            AI_AUDIO_MODEL: "claude-sonnet-4-5",
            AI_AUDIO_KEY: "audio-key",
        });

        const result = inferSupportedUploadedFiles([{ file: new File([""], "meeting.mp3"), checksum: "a" }]);

        expect(result).toEqual({
            ok: false,
            fileName: "meeting.mp3",
            message: "Audio uploads do not support AI_AUDIO_ADAPTER=anthropic",
        });
    });

    test("rejects unsupported media adapters when env validation is bypassed", () => {
        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "custom" as never,
            AI_AUDIO_MODEL: "transcribe",
            AI_AUDIO_KEY: "audio-key",
        });

        const result = inferSupportedUploadedFiles([{ file: new File([""], "meeting.mp3"), checksum: "a" }]);

        expect(result).toEqual({
            ok: false,
            fileName: "meeting.mp3",
            message: "Audio uploads do not support AI_AUDIO_ADAPTER=custom",
        });
    });

    test("returns inferred file types when media config is complete", () => {
        Object.assign(envMock, {
            AI_AUDIO_ADAPTER: "openai",
            AI_AUDIO_MODEL: "gpt-4o-mini-transcribe",
            AI_AUDIO_KEY: "audio-key",
            AI_VIDEO_ADAPTER: "azure",
            AI_VIDEO_MODEL: "gpt-4o-transcribe",
            AI_VIDEO_KEY: "video-key",
            AI_VIDEO_RESOURCE_NAME: "video-resource",
        });

        const result = inferSupportedUploadedFiles([
            { file: new File([""], "meeting.mp3"), checksum: "a" },
            { file: new File([""], "clip.mp4"), checksum: "v" },
            { file: new File([""], "notes.txt"), checksum: "t" },
        ]);

        expect(result).toEqual({
            ok: true,
            files: [
                { file: expect.any(File), checksum: "a", type: "audio" },
                { file: expect.any(File), checksum: "v", type: "video" },
                { file: expect.any(File), checksum: "t", type: "text" },
            ],
        });
    });
});

describe("unsupportedUploadResponse", () => {
    test("maps unsupported uploads to 415", () => {
        const response = unsupportedUploadResponse((code, body) => ({ code, body }), {
            ok: false,
            fileName: "meeting.mp3",
            message: "Audio uploads require AI_AUDIO_ADAPTER, AI_AUDIO_MODEL, and AI_AUDIO_KEY",
        });

        expect(response).toEqual({
            code: 415,
            body: {
                status: "error",
                message: "meeting.mp3: Audio uploads require AI_AUDIO_ADAPTER, AI_AUDIO_MODEL, and AI_AUDIO_KEY",
                code: API_ERROR_CODES.UNSUPPORTED_FILE_TYPE,
            },
        });
    });
});
