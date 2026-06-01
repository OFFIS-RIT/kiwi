import { getFile, getGraphFileArtifactPaths, putNamedFile } from "@kiwi/files";
import { renderPDFPagePreviews } from "@kiwi/graph/lib/pdf-page-preview";
import { getPdfPreviewPageKey } from "./text-unit-preview";

export type PDFPreviewPageResult =
    | {
          status: "ok";
          content: Uint8Array;
          cache: "hit" | "miss";
      }
    | {
          status: "source_missing";
      }
    | {
          status: "page_missing";
      };

type GetBytes = (key: string, bucket: string, type: "bytes") => Promise<{ type: "bytes"; content: ArrayBuffer } | null>;

type PutNamedFile = typeof putNamedFile;
type RenderPDFPagePreviews = typeof renderPDFPagePreviews;

type PDFPreviewRenderResult =
    | {
          status: "rendered";
          pages: Map<number, Uint8Array>;
      }
    | {
          status: "source_missing";
      };

type PDFPreviewCacheDeps = {
    getFile?: GetBytes;
    putNamedFile?: PutNamedFile;
    renderPDFPagePreviews?: RenderPDFPagePreviews;
};

const inFlightPreviewRenders = new Map<string, Promise<PDFPreviewRenderResult>>();

export async function getOrRenderPDFPreviewPage(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        page: number;
        pagesToRender?: number[];
        bucket: string;
    },
    deps: PDFPreviewCacheDeps = {}
): Promise<PDFPreviewPageResult> {
    const loadFile = deps.getFile ?? getFile;
    const saveNamedFile = deps.putNamedFile ?? putNamedFile;
    const renderPreview = deps.renderPDFPagePreviews ?? renderPDFPagePreviews;
    const cacheKey = getPdfPreviewPageKey({
        graphId: options.graphId,
        fileId: options.fileId,
        fileKey: options.fileKey,
        page: options.page,
    });
    const cachedImage = await loadFile(cacheKey, options.bucket, "bytes");

    if (cachedImage) {
        return {
            status: "ok",
            content: new Uint8Array(cachedImage.content),
            cache: "hit",
        };
    }

    const pagesToRender = uniquePositiveIntegers([options.page, ...(options.pagesToRender ?? [])]);
    const renderKey = getPdfPreviewRenderKey({ ...options, pagesToRender });
    const inFlightRender = inFlightPreviewRenders.get(renderKey);
    if (inFlightRender) {
        return toPDFPreviewPageResult(await inFlightRender, options.page);
    }

    const renderPromise = loadAndRenderPDFPreviewPages(
        {
            ...options,
            pagesToRender,
        },
        { getFile: loadFile, putNamedFile: saveNamedFile, renderPDFPagePreviews: renderPreview }
    );
    inFlightPreviewRenders.set(renderKey, renderPromise);

    try {
        return toPDFPreviewPageResult(await renderPromise, options.page);
    } finally {
        if (inFlightPreviewRenders.get(renderKey) === renderPromise) {
            inFlightPreviewRenders.delete(renderKey);
        }
    }
}

async function loadAndRenderPDFPreviewPages(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        pagesToRender: number[];
        bucket: string;
    },
    deps: Required<PDFPreviewCacheDeps>
): Promise<PDFPreviewRenderResult> {
    const sourceFile = await deps.getFile(options.fileKey, options.bucket, "bytes");
    if (!sourceFile) {
        return { status: "source_missing" };
    }

    return renderAndCachePDFPreviewPages(
        {
            graphId: options.graphId,
            fileId: options.fileId,
            fileKey: options.fileKey,
            pagesToRender: options.pagesToRender,
            bucket: options.bucket,
            source: new Uint8Array(sourceFile.content),
        },
        deps
    );
}

async function renderAndCachePDFPreviewPages(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        pagesToRender: number[];
        bucket: string;
        source: Uint8Array;
    },
    deps: Required<Pick<PDFPreviewCacheDeps, "putNamedFile" | "renderPDFPagePreviews">>
): Promise<PDFPreviewRenderResult> {
    const renderedPages = await deps.renderPDFPagePreviews(options.source, options.pagesToRender);
    const paths = getGraphFileArtifactPaths(options);

    await Promise.allSettled(
        [...renderedPages.entries()].map(([page, renderedImage]) =>
            deps.putNamedFile(`page-${page}.png`, renderedImage, paths.derivedPdfPreviewPrefix, options.bucket)
        )
    );

    return {
        status: "rendered",
        pages: renderedPages,
    };
}

function toPDFPreviewPageResult(result: PDFPreviewRenderResult, page: number): PDFPreviewPageResult {
    if (result.status === "source_missing") {
        return result;
    }

    const image = result.pages.get(page);
    if (!image) {
        return { status: "page_missing" };
    }

    return {
        status: "ok",
        content: image,
        cache: "miss",
    };
}

function getPdfPreviewRenderKey(options: {
    bucket: string;
    graphId: string;
    fileId: string;
    fileKey: string;
    pagesToRender: number[];
}): string {
    return JSON.stringify([options.bucket, options.graphId, options.fileId, options.fileKey, options.pagesToRender]);
}

function uniquePositiveIntegers(values: number[]): number[] {
    const seen = new Set<number>();
    const result: number[] = [];

    for (const value of values) {
        if (!Number.isInteger(value) || value < 1 || seen.has(value)) {
            continue;
        }

        seen.add(value);
        result.push(value);
    }

    return result.sort((a, b) => a - b);
}
