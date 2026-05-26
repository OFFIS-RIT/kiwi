import type { ResolvedCitationFence } from "@kiwi/ai/citation";

type PageRange = {
    startPage: number;
    endPage: number;
    citation: ResolvedCitationFence;
};

type SourceFileGroup = {
    fileRef: string;
    fallback: ResolvedCitationFence | null;
    ranges: PageRange[];
};

export type SourceFileCitation = {
    key: string;
    label: string;
    citation: ResolvedCitationFence;
};

function citationFileRef(citation: ResolvedCitationFence): string {
    return citation.fileId ?? citation.fileKey ?? citation.sourceId;
}

function positivePage(value: number | undefined): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

export function citationReferenceKey(citation: ResolvedCitationFence): string {
    return [
        citation.unitId,
        citationFileRef(citation),
        positivePage(citation.startPage) ?? "",
        positivePage(citation.endPage) ?? "",
    ].join(":");
}

function citationPageRange(citation: ResolvedCitationFence): PageRange | null {
    const startPage = positivePage(citation.startPage ?? citation.endPage);
    const endPage = positivePage(citation.endPage ?? citation.startPage);

    if (startPage === null || endPage === null || endPage < startPage) {
        return null;
    }

    return { startPage, endPage, citation };
}

function formatPageRange(range: Pick<PageRange, "startPage" | "endPage">): string {
    return range.startPage === range.endPage ? String(range.startPage) : `${range.startPage} - ${range.endPage}`;
}

function mergePageRanges(ranges: PageRange[]): PageRange[] {
    const mergedRanges: PageRange[] = [];

    const sortedRanges = [...ranges].sort(
        (left, right) => left.startPage - right.startPage || left.endPage - right.endPage
    );

    for (const range of sortedRanges) {
        const current = mergedRanges.at(-1);
        if (current && range.startPage <= current.endPage) {
            current.endPage = Math.max(current.endPage, range.endPage);
            continue;
        }

        mergedRanges.push({ ...range });
    }

    return mergedRanges;
}

export function buildSourceFileCitations(citations: ResolvedCitationFence[]): SourceFileCitation[] {
    const groups = new Map<string, SourceFileGroup>();

    for (const citation of citations) {
        const fileRef = citationFileRef(citation);
        let group = groups.get(fileRef);
        if (!group) {
            group = { fileRef, fallback: null, ranges: [] };
            groups.set(fileRef, group);
        }

        const range = citationPageRange(citation);
        if (range) {
            group.ranges.push(range);
        } else {
            group.fallback ??= citation;
        }
    }

    return Array.from(groups.values()).flatMap((group) => {
        const ranges = mergePageRanges(group.ranges);
        if (ranges.length === 0) {
            return group.fallback
                ? [{ key: group.fileRef, label: group.fallback.fileName, citation: group.fallback }]
                : [];
        }

        return ranges.map((range) => ({
            key: `${group.fileRef}:${range.startPage}-${range.endPage}`,
            label: `${range.citation.fileName} ${formatPageRange(range)}`,
            citation: {
                ...range.citation,
                startPage: range.startPage,
                endPage: range.endPage,
            },
        }));
    });
}
