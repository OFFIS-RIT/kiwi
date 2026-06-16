export type PageAwareChunk = {
    content: string;
    startPage: number | null;
    endPage: number | null;
};

export type PageAwareChunkWithSource<T> = PageAwareChunk & {
    source: T;
};

export type PageFence = {
    page: number;
    index: number;
    length: number;
};

const PAGE_FENCE_PATTERN = /:::PAGE-(\d+):::/g;
const STANDALONE_PAGE_FENCE_LINE_PATTERN = /^\s*:::PAGE-\d+:::\s*$/;

export function renderPageFence(page: number): string {
    if (!Number.isInteger(page) || page < 1) {
        throw new Error(`Invalid page number ${page}`);
    }

    return `:::PAGE-${page}:::`;
}

export function extractPageFences(text: string): PageFence[] {
    const fences: PageFence[] = [];

    for (const match of text.matchAll(PAGE_FENCE_PATTERN)) {
        const page = Number(match[1]);
        if (!Number.isInteger(page) || page < 1 || match.index === undefined) {
            continue;
        }

        fences.push({
            page,
            index: match.index,
            length: match[0].length,
        });
    }

    return fences;
}

export function stripPageFences(text: string): string {
    const withoutStandaloneFenceLines = text
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !STANDALONE_PAGE_FENCE_LINE_PATTERN.test(line))
        .join("\n");

    return withoutStandaloneFenceLines
        .replace(PAGE_FENCE_PATTERN, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function toPageAwareChunks(rawChunks: string[]): PageAwareChunk[] {
    return toPageAwareChunksWithSource(rawChunks, (rawChunk) => rawChunk).map(({ source: _source, ...chunk }) => chunk);
}

export function toPageAwareChunksWithSource<T>(
    rawChunks: T[],
    getRawChunk: (rawChunk: T) => string
): Array<PageAwareChunkWithSource<T>> {
    const chunks: Array<PageAwareChunkWithSource<T>> = [];
    let currentPage: number | null = null;

    for (const source of rawChunks) {
        const rawChunk = getRawChunk(source);
        const fences = extractPageFences(rawChunk);
        const content = stripPageFences(rawChunk);

        if (fences.length === 0) {
            if (content !== "") {
                chunks.push({
                    content,
                    startPage: currentPage,
                    endPage: currentPage,
                    source,
                });
            }
            continue;
        }

        const span = getContentPageSpan(rawChunk, fences, currentPage);
        currentPage = fences[fences.length - 1]!.page;

        if (content === "") {
            continue;
        }

        chunks.push({
            content,
            startPage: span.startPage,
            endPage: span.endPage,
            source,
        });
    }

    return chunks;
}

function getContentPageSpan(
    rawChunk: string,
    fences: PageFence[],
    initialPage: number | null
): Pick<PageAwareChunk, "startPage" | "endPage"> {
    const pagesWithContent: number[] = [];
    let activePage = initialPage;
    let cursor = 0;

    for (const fence of fences) {
        addContentPage(rawChunk.slice(cursor, fence.index), activePage, pagesWithContent);
        activePage = fence.page;
        cursor = fence.index + fence.length;
    }

    addContentPage(rawChunk.slice(cursor), activePage, pagesWithContent);

    if (pagesWithContent.length === 0) {
        return { startPage: null, endPage: null };
    }

    return {
        startPage: pagesWithContent[0]!,
        endPage: pagesWithContent[pagesWithContent.length - 1]!,
    };
}

function addContentPage(rawContent: string, page: number | null, pagesWithContent: number[]): void {
    if (page === null || stripPageFences(rawContent) === "") {
        return;
    }

    pagesWithContent.push(page);
}
