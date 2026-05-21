import { getDerivedPdfPreviewPrefix } from "@kiwi/files";
import type { TextUnitPreview } from "../types/routes";

export function buildTextUnitPreview(options: {
    graphId: string;
    unitId: string;
    fileType: string;
    startPage: number | null;
    endPage: number | null;
}): TextUnitPreview {
    if (
        options.fileType !== "pdf" ||
        options.startPage === null ||
        options.endPage === null ||
        options.endPage < options.startPage
    ) {
        return { type: "none" };
    }

    const startPage = options.startPage;
    const endPage = options.endPage;

    return {
        type: "pdf_pages",
        start_page: startPage,
        end_page: endPage,
        pages: Array.from({ length: endPage - startPage + 1 }, (_, index) => {
            const page = startPage + index;
            return {
                page,
                image_path: `/graphs/${encodeURIComponent(options.graphId)}/units/${encodeURIComponent(options.unitId)}/pages/${page}.png`,
            };
        }),
    };
}

export function parsePageImageParam(value: string): number | null {
    const match = /^(\d+)\.png$/u.exec(value);
    if (!match) {
        return null;
    }

    const page = Number(match[1]);
    return Number.isInteger(page) && page >= 1 ? page : null;
}

export function getPdfPreviewPageKey(graphId: string, fileId: string, page: number): string {
    return `${getPdfPreviewPagePrefix(graphId, fileId)}/page-${page}.png`;
}

export function getPdfPreviewPagePrefix(graphId: string, fileId: string): string {
    return getDerivedPdfPreviewPrefix(graphId, fileId);
}
