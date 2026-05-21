export type PageAwareChunk = {
    content: string;
    startPage: number | null;
    endPage: number | null;
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
    const chunks: PageAwareChunk[] = [];
    let currentPage: number | null = null;

    for (const rawChunk of rawChunks) {
        const fences = extractPageFences(rawChunk);
        const content = stripPageFences(rawChunk);

        if (fences.length === 0) {
            if (content !== "") {
                chunks.push({
                    content,
                    startPage: currentPage,
                    endPage: currentPage,
                });
            }
            continue;
        }

        const firstFence = fences[0]!;
        const lastFence = fences[fences.length - 1]!;
        const prefix = rawChunk.slice(0, firstFence.index);
        const hasContentBeforeFirstFence = stripPageFences(prefix) !== "";
        const startPage = hasContentBeforeFirstFence && currentPage !== null ? currentPage : firstFence.page;
        const endPage = lastFence.page;

        currentPage = lastFence.page;

        if (content === "") {
            continue;
        }

        chunks.push({
            content,
            startPage,
            endPage,
        });
    }

    return chunks;
}
