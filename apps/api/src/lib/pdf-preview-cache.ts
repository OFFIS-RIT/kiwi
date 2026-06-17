import { getFile, getGraphFileArtifactPaths, putNamedFile } from "@kiwi/files";
import * as Effect from "effect/Effect";
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

type GetBytes = (key: string, bucket: string, type: "bytes") => Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, unknown>;

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

export function getOrRenderPDFPreviewPage(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        page: number;
        pagesToRender?: number[];
        bucket: string;
    },
    deps: PDFPreviewCacheDeps = {}
): Effect.Effect<PDFPreviewPageResult, unknown> {
    return Effect.gen(function* () {
        const loadFile = deps.getFile ?? getFile;
        const saveNamedFile = deps.putNamedFile ?? putNamedFile;
        const renderPreview = deps.renderPDFPagePreviews ?? renderPDFPagePreviews;
        const cacheKey = getPdfPreviewPageKey({
            graphId: options.graphId,
            fileId: options.fileId,
            fileKey: options.fileKey,
            page: options.page,
        });
        const cachedImage = yield* loadFile(cacheKey, options.bucket, "bytes");

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
            return toPDFPreviewPageResult(yield* Effect.tryPromise(() => inFlightRender), options.page);
        }

        const renderPromise = Effect.runPromise(
            loadAndRenderPDFPreviewPages(
                {
                    ...options,
                    pagesToRender,
                },
                { getFile: loadFile, putNamedFile: saveNamedFile, renderPDFPagePreviews: renderPreview }
            )
        );
        inFlightPreviewRenders.set(renderKey, renderPromise);

        try {
            return toPDFPreviewPageResult(yield* Effect.tryPromise(() => renderPromise), options.page);
        } finally {
            if (inFlightPreviewRenders.get(renderKey) === renderPromise) {
                inFlightPreviewRenders.delete(renderKey);
            }
        }
    });
}

function loadAndRenderPDFPreviewPages(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        pagesToRender: number[];
        bucket: string;
    },
    deps: Required<PDFPreviewCacheDeps>
): Effect.Effect<PDFPreviewRenderResult, unknown> {
    return Effect.gen(function* () {
        const sourceFile = yield* deps.getFile(options.fileKey, options.bucket, "bytes");
        if (!sourceFile) {
            return { status: "source_missing" };
        }

        return yield* renderAndCachePDFPreviewPages(
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
    });
}

function renderAndCachePDFPreviewPages(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        pagesToRender: number[];
        bucket: string;
        source: Uint8Array;
    },
    deps: Required<Pick<PDFPreviewCacheDeps, "putNamedFile" | "renderPDFPagePreviews">>
): Effect.Effect<PDFPreviewRenderResult, unknown> {
    return Effect.gen(function* () {
        const renderedPages = yield* deps.renderPDFPagePreviews(options.source, options.pagesToRender);
        const paths = getGraphFileArtifactPaths(options);

        yield* Effect.tryPromise(() =>
            Promise.allSettled(
                [...renderedPages.entries()].map(([page, renderedImage]) =>
                    Effect.runPromise(
                        deps.putNamedFile(`page-${page}.png`, renderedImage, paths.derivedPdfPreviewPrefix, options.bucket)
                    )
                )
            )
        );

        return {
            status: "rendered",
            pages: renderedPages,
        };
    });
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
