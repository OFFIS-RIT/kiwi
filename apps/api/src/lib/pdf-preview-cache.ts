import { getFile, getGraphFileArtifactPaths, putNamedFile } from "@kiwi/files";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
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

export class PDFPreviewCacheError extends Schema.TaggedErrorClass<PDFPreviewCacheError>()("PDFPreviewCacheError", {
    message: Schema.String,
    cause: Schema.Unknown,
}) {}

type GetBytes = (
    key: string,
    bucket: string,
    type: "bytes"
) => Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, unknown>;

type PutNamedFile = (
    name: string,
    file: File | Blob | Uint8Array | string,
    path: string,
    bucket: string
) => Effect.Effect<unknown, unknown>;
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

const inFlightPreviewRenders = new Map<string, Deferred.Deferred<PDFPreviewRenderResult, PDFPreviewCacheError>>();

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
): Effect.Effect<PDFPreviewPageResult, PDFPreviewCacheError> {
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
        const cachedImage = yield* Effect.mapError(
            loadFile(cacheKey, options.bucket, "bytes"),
            (cause) => new PDFPreviewCacheError({ message: "Failed to load cached PDF preview page", cause })
        );

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
            return toPDFPreviewPageResult(yield* Deferred.await(inFlightRender), options.page);
        }

        const renderDeferred = yield* Deferred.make<PDFPreviewRenderResult, PDFPreviewCacheError>();
        inFlightPreviewRenders.set(renderKey, renderDeferred);

        const renderExit = yield* Effect.exit(
            loadAndRenderPDFPreviewPages(
                {
                    ...options,
                    pagesToRender,
                },
                { getFile: loadFile, putNamedFile: saveNamedFile, renderPDFPagePreviews: renderPreview }
            )
        );
        yield* Deferred.done(renderDeferred, renderExit);
        if (inFlightPreviewRenders.get(renderKey) === renderDeferred) {
            inFlightPreviewRenders.delete(renderKey);
        }

        return toPDFPreviewPageResult(yield* Deferred.await(renderDeferred), options.page);
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
): Effect.Effect<PDFPreviewRenderResult, PDFPreviewCacheError> {
    return Effect.gen(function* () {
        const sourceFile = yield* Effect.mapError(
            deps.getFile(options.fileKey, options.bucket, "bytes"),
            (cause) => new PDFPreviewCacheError({ message: "Failed to load source PDF for preview rendering", cause })
        );
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
): Effect.Effect<PDFPreviewRenderResult, PDFPreviewCacheError> {
    return Effect.gen(function* () {
        const renderedPages = yield* Effect.mapError(
            deps.renderPDFPagePreviews(options.source, options.pagesToRender),
            (cause) => new PDFPreviewCacheError({ message: "Failed to render PDF preview pages", cause })
        );
        const paths = getGraphFileArtifactPaths(options);

        yield* Effect.all(
            [...renderedPages.entries()].map(([page, renderedImage]) =>
                Effect.exit(
                    deps.putNamedFile(`page-${page}.png`, renderedImage, paths.derivedPdfPreviewPrefix, options.bucket)
                )
            ),
            { concurrency: "unbounded", discard: true }
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
