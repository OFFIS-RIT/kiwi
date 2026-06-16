import { describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import { getOrRenderPDFPreviewPage } from "../pdf-preview-cache";

const options = {
    graphId: "graph-1",
    fileId: "file-1",
    fileKey: "graphs/graph-1/file-1.pdf",
    page: 3,
    bucket: "bucket-1",
};

describe("getOrRenderPDFPreviewPage", () => {
    test("returns cached PNG bytes without rendering", async () => {
        const renderPDFPagePreviews = mock(async () => new Map<number, Uint8Array>());
        const putNamedFile = mock(() => Effect.succeed({ key: "unused", type: "image/png" }));

        const result = await getOrRenderPDFPreviewPage(options, {
            getFile: (key) =>
                Effect.succeed(key.endsWith("/page-3.png") ? { type: "bytes" as const, content: new Uint8Array([1]).buffer } : null),
            putNamedFile,
            renderPDFPagePreviews,
        });

        expect(result).toEqual({ status: "ok", content: new Uint8Array([1]), cache: "hit" });
        expect(renderPDFPagePreviews).not.toHaveBeenCalled();
        expect(putNamedFile).not.toHaveBeenCalled();
    });

    test("renders and stores PNG bytes on cache miss", async () => {
        const putNamedFile = mock(() => Effect.succeed({ key: "saved", type: "image/png" }));
        const renderPDFPagePreviews = mock(
            async () =>
                new Map([
                    [3, new Uint8Array([3])],
                    [4, new Uint8Array([4])],
                ])
        );

        const result = await getOrRenderPDFPreviewPage(options, {
            getFile: (key) =>
                Effect.succeed(key === options.fileKey ? { type: "bytes" as const, content: new Uint8Array([9]).buffer } : null),
            putNamedFile,
            renderPDFPagePreviews,
        });

        expect(result).toEqual({ status: "ok", content: new Uint8Array([3]), cache: "miss" });
        expect(renderPDFPagePreviews).toHaveBeenCalledWith(new Uint8Array([9]), [3]);
        expect(putNamedFile).toHaveBeenCalledTimes(2);
        expect(putNamedFile).toHaveBeenCalledWith(
            "page-3.png",
            new Uint8Array([3]),
            "graphs/graph-1/file-1.pdf/file-1/pdf-preview/v1/scale-1.5",
            "bucket-1"
        );
    });

    test("deduplicates concurrent renders for the same preview page", async () => {
        const putNamedFile = mock(() => Effect.succeed({ key: "saved", type: "image/png" }));
        const getFile = mock((key: string) =>
            Effect.succeed(key === options.fileKey ? { type: "bytes" as const, content: new Uint8Array([9]).buffer } : null)
        );
        const renderPDFPagePreviews = mock(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return new Map([[3, new Uint8Array([3])]]);
        });

        const [first, second] = await Promise.all([
            getOrRenderPDFPreviewPage(options, { getFile, putNamedFile, renderPDFPagePreviews }),
            getOrRenderPDFPreviewPage(options, { getFile, putNamedFile, renderPDFPagePreviews }),
        ]);

        expect(first).toEqual({ status: "ok", content: new Uint8Array([3]), cache: "miss" });
        expect(second).toEqual(first);
        expect(renderPDFPagePreviews).toHaveBeenCalledTimes(1);
        expect(putNamedFile).toHaveBeenCalledTimes(1);
    });

    test("shares concurrent renders for different requested pages in the same preview window", async () => {
        let releaseRender!: () => void;
        const renderGate = new Promise<void>((resolve) => {
            releaseRender = resolve;
        });
        const putNamedFile = mock(() => Effect.succeed({ key: "saved", type: "image/png" }));
        const getFile = mock((key: string) =>
            Effect.succeed(key === options.fileKey ? { type: "bytes" as const, content: new Uint8Array([9]).buffer } : null)
        );
        const renderPDFPagePreviews = mock(async () => {
            await renderGate;
            return new Map([
                [3, new Uint8Array([3])],
                [4, new Uint8Array([4])],
            ]);
        });
        const deps = { getFile, putNamedFile, renderPDFPagePreviews };

        const first = getOrRenderPDFPreviewPage({ ...options, page: 3, pagesToRender: [3, 4] }, deps);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const second = getOrRenderPDFPreviewPage({ ...options, page: 4, pagesToRender: [3, 4] }, deps);
        releaseRender();

        await expect(first).resolves.toEqual({ status: "ok", content: new Uint8Array([3]), cache: "miss" });
        await expect(second).resolves.toEqual({ status: "ok", content: new Uint8Array([4]), cache: "miss" });
        expect(renderPDFPagePreviews).toHaveBeenCalledTimes(1);
        expect(renderPDFPagePreviews).toHaveBeenCalledWith(new Uint8Array([9]), [3, 4]);
        expect(putNamedFile).toHaveBeenCalledTimes(2);
    });

    test("returns rendered image when cache writes fail", async () => {
        const putNamedFile = mock(() => Effect.fail(new Error("Storage unavailable")));
        const renderPDFPagePreviews = mock(async () => new Map([[3, new Uint8Array([3])]]));

        const result = await getOrRenderPDFPreviewPage(options, {
            getFile: (key) =>
                Effect.succeed(key === options.fileKey ? { type: "bytes" as const, content: new Uint8Array([9]).buffer } : null),
            putNamedFile,
            renderPDFPagePreviews,
        });

        expect(result).toEqual({ status: "ok", content: new Uint8Array([3]), cache: "miss" });
        expect(putNamedFile).toHaveBeenCalledTimes(1);
    });

    test("renders the requested page together with the preview window", async () => {
        const putNamedFile = mock(() => Effect.succeed({ key: "saved", type: "image/png" }));
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
                getFile: (key) =>
                    Effect.succeed(key === options.fileKey ? { type: "bytes" as const, content: new Uint8Array([9]).buffer } : null),
                putNamedFile,
                renderPDFPagePreviews,
            }
        );

        expect(renderPDFPagePreviews).toHaveBeenCalledWith(new Uint8Array([9]), [3, 4]);
    });

    test("reports missing source file", async () => {
        const result = await getOrRenderPDFPreviewPage(options, {
            getFile: () => Effect.succeed(null),
            putNamedFile: mock(() => Effect.succeed({ key: "unused", type: "image/png" })),
            renderPDFPagePreviews: mock(async () => new Map()),
        });

        expect(result).toEqual({ status: "source_missing" });
    });

    test("reports missing rendered page without throwing", async () => {
        const putNamedFile = mock(() => Effect.succeed({ key: "unused", type: "image/png" }));
        const renderPDFPagePreviews = mock(async () => new Map<number, Uint8Array>());

        const result = await getOrRenderPDFPreviewPage(options, {
            getFile: (key) =>
                Effect.succeed(key === options.fileKey ? { type: "bytes" as const, content: new Uint8Array([9]).buffer } : null),
            putNamedFile,
            renderPDFPagePreviews,
        });

        expect(result).toEqual({ status: "page_missing" });
        expect(putNamedFile).not.toHaveBeenCalled();
    });
});
