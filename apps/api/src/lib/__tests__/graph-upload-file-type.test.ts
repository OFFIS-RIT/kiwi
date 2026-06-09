import { beforeEach, describe, expect, mock, test } from "bun:test";
import { API_ERROR_CODES } from "../../types";

const resolveRequiredModelAdapterMock = mock(async () => ({ adapter: {} }));

const { assertConfiguredUploadModels, inferSupportedUploadedFiles, unsupportedUploadResponse } =
    await import("../graph-upload-file-type");

describe("inferSupportedUploadedFiles", () => {
    beforeEach(() => {
        resolveRequiredModelAdapterMock.mockClear();
    });

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

    test("requires configured audio and video models before media upload processing", async () => {
        const result = inferSupportedUploadedFiles([
            { file: new File([""], "meeting.mp3"), checksum: "a" },
            { file: new File([""], "clip.mp4"), checksum: "v" },
            { file: new File([""], "notes.txt"), checksum: "t" },
        ]);

        if (!result.ok) {
            throw new Error("expected supported upload");
        }

        await assertConfiguredUploadModels({
            organizationId: "org-1",
            files: result.files,
            secret: "test-secret",
            resolveModelAdapter: resolveRequiredModelAdapterMock,
        });

        expect(resolveRequiredModelAdapterMock).toHaveBeenCalledTimes(2);
        expect(resolveRequiredModelAdapterMock).toHaveBeenCalledWith("org-1", "audio", "test-secret");
        expect(resolveRequiredModelAdapterMock).toHaveBeenCalledWith("org-1", "video", "test-secret");
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
