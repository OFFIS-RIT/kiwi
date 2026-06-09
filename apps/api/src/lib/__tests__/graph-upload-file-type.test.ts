import { describe, expect, test } from "bun:test";
import { API_ERROR_CODES } from "../../types";

const { inferSupportedUploadedFiles, unsupportedUploadResponse } = await import("../graph-upload-file-type");

describe("inferSupportedUploadedFiles", () => {
    test("returns inferred file types without checking AI provider env vars", () => {
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
            fileName: "archive.bin",
            message: "Unsupported file type",
        });

        expect(response).toEqual({
            code: 415,
            body: {
                status: "error",
                message: "archive.bin: Unsupported file type",
                code: API_ERROR_CODES.UNSUPPORTED_FILE_TYPE,
            },
        });
    });
});
