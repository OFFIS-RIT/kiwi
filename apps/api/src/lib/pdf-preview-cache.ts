import { getFile, putNamedFile } from "@kiwi/files";
import { renderPDFPagePreviews } from "@kiwi/graph/lib/pdf-page-preview";
import { getPdfPreviewPageKey, getPdfPreviewPagePrefix } from "./text-unit-preview";

export type PDFPreviewPageResult =
    | {
          status: "ok";
          content: Uint8Array;
          cache: "hit" | "miss";
      }
    | {
          status: "source_missing";
      };

type GetBytes = (key: string, bucket: string, type: "bytes") => Promise<{ type: "bytes"; content: ArrayBuffer } | null>;

type PutNamedFile = typeof putNamedFile;
type RenderPDFPagePreviews = typeof renderPDFPagePreviews;

type PDFPreviewCacheDeps = {
    getFile?: GetBytes;
    putNamedFile?: PutNamedFile;
    renderPDFPagePreviews?: RenderPDFPagePreviews;
};

export async function getOrRenderPDFPreviewPage(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        page: number;
        bucket: string;
    },
    deps: PDFPreviewCacheDeps = {}
): Promise<PDFPreviewPageResult> {
    const loadFile = deps.getFile ?? getFile;
    const saveNamedFile = deps.putNamedFile ?? putNamedFile;
    const renderPreview = deps.renderPDFPagePreviews ?? renderPDFPagePreviews;
    const cacheKey = getPdfPreviewPageKey(options.graphId, options.fileId, options.page);
    const cachedImage = await loadFile(cacheKey, options.bucket, "bytes");

    if (cachedImage) {
        return {
            status: "ok",
            content: new Uint8Array(cachedImage.content),
            cache: "hit",
        };
    }

    const sourceFile = await loadFile(options.fileKey, options.bucket, "bytes");
    if (!sourceFile) {
        return { status: "source_missing" };
    }

    const renderedPages = await renderPreview(new Uint8Array(sourceFile.content), [options.page]);
    const image = renderedPages.get(options.page);
    if (!image) {
        throw new Error(`PDF preview renderer returned no image for page ${options.page}`);
    }

    await saveNamedFile(
        `page-${options.page}.png`,
        image,
        getPdfPreviewPagePrefix(options.graphId, options.fileId),
        options.bucket
    );

    return {
        status: "ok",
        content: image,
        cache: "miss",
    };
}
