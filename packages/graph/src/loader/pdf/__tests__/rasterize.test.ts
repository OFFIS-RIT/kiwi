import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, mock, test } from "bun:test";

function createProcessStream() {
    const stream = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
    stream.setEncoding = () => {};
    return stream;
}

const ghostscriptSpawnMock = mock((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
        stdout: ReturnType<typeof createProcessStream>;
        stderr: ReturnType<typeof createProcessStream>;
    };
    child.stdout = createProcessStream();
    child.stderr = createProcessStream();

    queueMicrotask(() => {
        void (async () => {
            try {
                const outputPattern = args
                    .find((arg) => arg.startsWith("-sOutputFile="))!
                    .slice("-sOutputFile=".length);
                const firstPage = Number(args.find((arg) => arg.startsWith("-dFirstPage="))!.split("=")[1]);
                const lastPage = Number(args.find((arg) => arg.startsWith("-dLastPage="))!.split("=")[1]);

                let outputNumber = 1;
                for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
                    await writeFile(outputPattern.replace("%d", String(outputNumber)), new Uint8Array([pageNumber]));
                    outputNumber += 1;
                }

                child.emit("close", 0);
            } catch (error) {
                child.emit("error", error);
            }
        })();
    });

    return child;
});

mock.module("node:child_process", () => ({
    spawn: ghostscriptSpawnMock,
}));

let activePageReads = 0;
let maxActivePageReads = 0;
const pdfToImgMock = mock(async () => ({
    getPage: async (pageNumber: number) => {
        activePageReads += 1;
        maxActivePageReads = Math.max(maxActivePageReads, activePageReads);
        await Promise.resolve();
        activePageReads -= 1;
        return new Uint8Array([pageNumber]);
    },
}));

mock.module("pdf-to-img", () => ({
    pdf: pdfToImgMock,
}));

const {
    GhostscriptUnavailableError,
    rasterizeSelectedPDFPages,
    rasterizeSelectedPDFPagesWithGhostscript,
    rasterizeSelectedPDFPagesWithPDFToImg,
    splitPagesIntoContiguousRanges,
} = await import("../rasterize");

describe("rasterizeSelectedPDFPages", () => {
    beforeEach(() => {
        activePageReads = 0;
        maxActivePageReads = 0;
        pdfToImgMock.mockClear();
        ghostscriptSpawnMock.mockClear();
    });

    const pages = [{ index: 1, width: 600, height: 800 }];

    test("uses Ghostscript when available", async () => {
        const ghostscript = mock(async () => new Map([[1, new Uint8Array([1])]]));
        const pdfToImg = mock(async () => new Map([[1, new Uint8Array([2])]]));

        const result = await rasterizeSelectedPDFPages(new Uint8Array([9]), pages, 1.5, {
            ghostscript,
            pdfToImg,
        });

        expect(result).toEqual(new Map([[1, new Uint8Array([1])]]));
        expect(ghostscript).toHaveBeenCalledTimes(1);
        expect(pdfToImg).not.toHaveBeenCalled();
    });

    test("falls back to pdf-to-img when Ghostscript is unavailable", async () => {
        const ghostscript = mock(async () => {
            throw new GhostscriptUnavailableError("missing gs");
        });
        const pdfToImg = mock(async () => new Map([[1, new Uint8Array([2])]]));

        const result = await rasterizeSelectedPDFPages(new Uint8Array([9]), pages, 1.5, {
            ghostscript,
            pdfToImg,
        });

        expect(result).toEqual(new Map([[1, new Uint8Array([2])]]));
        expect(ghostscript).toHaveBeenCalledTimes(1);
        expect(pdfToImg).toHaveBeenCalledTimes(1);
    });

    test("splits requested pages into contiguous ranges", () => {
        const ranges = splitPagesIntoContiguousRanges([
            { index: 49 },
            { index: 0 },
            { index: 1 },
            { index: 4 },
            { index: 5 },
            { index: 5 },
        ]);

        expect(ranges.map((range) => range.map((page) => page.index))).toEqual([[0, 1], [4, 5], [49]]);
    });

    test("reads Ghostscript range outputs by render sequence", async () => {
        const result = await rasterizeSelectedPDFPagesWithGhostscript(
            new Uint8Array([9]),
            [{ index: 2 }, { index: 3 }, { index: 4 }],
            1.5
        );

        expect(result).toEqual(
            new Map([
                [2, new Uint8Array([3])],
                [3, new Uint8Array([4])],
                [4, new Uint8Array([5])],
            ])
        );
        expect(ghostscriptSpawnMock).toHaveBeenCalledTimes(1);
    });

    test("renders pdf-to-img fallback pages sequentially", async () => {
        const result = await rasterizeSelectedPDFPagesWithPDFToImg(
            new Uint8Array([9]),
            [{ index: 0 }, { index: 1 }, { index: 2 }],
            1.5
        );

        expect(result).toEqual(
            new Map([
                [0, new Uint8Array([1])],
                [1, new Uint8Array([2])],
                [2, new Uint8Array([3])],
            ])
        );
        expect(maxActivePageReads).toBe(1);
        expect(pdfToImgMock).toHaveBeenCalledTimes(1);
    });
});
