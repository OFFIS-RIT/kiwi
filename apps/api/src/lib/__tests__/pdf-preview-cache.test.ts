import { describe, expect, mock, test } from "bun:test";
import { getOrRenderPDFPreviewPage } from "../pdf-preview-cache";

const options = {
    graphId: "graph-1",
    fileId: "file-1",
    fileKey: "source.pdf",
    page: 3,
    bucket: "bucket-1",
};

describe("getOrRenderPDFPreviewPage", () => {
    test("returns cached PNG bytes without rendering", async () => {
        const renderPDFPagePreviews = mock(async () => new Map<number, Uint8Array>());
        const putNamedFile = mock(async () => ({ key: "unused", type: "image/png" }));

        const result = await getOrRenderPDFPreviewPage(options, {
            getFile: async (key) =>
                key.endsWith("/page-3.png") ? { type: "bytes", content: new Uint8Array([1]).buffer } : null,
            putNamedFile,
            renderPDFPagePreviews,
        });

        expect(result).toEqual({ status: "ok", content: new Uint8Array([1]), cache: "hit" });
        expect(renderPDFPagePreviews).not.toHaveBeenCalled();
        expect(putNamedFile).not.toHaveBeenCalled();
    });

    test("renders and stores PNG bytes on cache miss", async () => {
        const putNamedFile = mock(async () => ({ key: "saved", type: "image/png" }));
        const renderPDFPagePreviews = mock(
            async () =>
                new Map([
                    [3, new Uint8Array([3])],
                    [4, new Uint8Array([4])],
                ])
        );

        const result = await getOrRenderPDFPreviewPage(options, {
            getFile: async (key) =>
                key === "source.pdf" ? { type: "bytes", content: new Uint8Array([9]).buffer } : null,
            putNamedFile,
            renderPDFPagePreviews,
        });

        expect(result).toEqual({ status: "ok", content: new Uint8Array([3]), cache: "miss" });
        expect(renderPDFPagePreviews).toHaveBeenCalledWith(new Uint8Array([9]), [3]);
        expect(putNamedFile).toHaveBeenCalledTimes(2);
        expect(putNamedFile).toHaveBeenCalledWith(
            "page-3.png",
            new Uint8Array([3]),
            "graphs/graph-1/derived/file-1/pdf-preview/v1/scale-1.5",
            "bucket-1"
        );
    });

    test("renders the requested page together with the preview window", async () => {
        const putNamedFile = mock(async () => ({ key: "saved", type: "image/png" }));
        const renderPDFPagePreviews = mock(
            async () =>
                new Map([
                    [3, new Uint8Array([3])],
                    [4, new Uint8Array([4])],
                ])
        );

        await getOrRenderPDFPreviewPage(
            { ...options, pagesToRender: [3, 4] },
            {
                getFile: async (key) =>
                    key === "source.pdf" ? { type: "bytes", content: new Uint8Array([9]).buffer } : null,
                putNamedFile,
                renderPDFPagePreviews,
            }
        );

        expect(renderPDFPagePreviews).toHaveBeenCalledWith(new Uint8Array([9]), [3, 4]);
    });

    test("reports missing source file", async () => {
        const result = await getOrRenderPDFPreviewPage(options, {
            getFile: async () => null,
            putNamedFile: mock(async () => ({ key: "unused", type: "image/png" })),
            renderPDFPagePreviews: mock(async () => new Map()),
        });

        expect(result).toEqual({ status: "source_missing" });
    });
});
