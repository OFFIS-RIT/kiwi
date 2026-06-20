import type { ResolvedCitationFence } from "@kiwi/ai/citation";

export type SourceReferenceLink = {
    unit: {
        external_url: string | null;
    };
};

type PageRange = {
    startPage: number;
    endPage: number;
    citation: ResolvedCitationFence;
};

type SourceFileGroup = {
    fallback: ResolvedCitationFence | null;
    ranges: PageRange[];
};

export type SourceFileCitation = {
    key: string;
    /** File name rendered as the main button/link text. */
    fileName: string;
    /** Compact page badge label (e.g. "S. 1 - 4"); null for page-less citations. */
    pageLabel: string | null;
    /** Accessible name combining file name and page range (e.g. "document.pdf S. 1 - 4"). */
    accessibleLabel: string;
    citation: ResolvedCitationFence;
    externalUrl: string | null;
};

function citationFileRef(citation: ResolvedCitationFence): string {
    return citation.fileId ?? citation.fileKey ?? citation.sourceId;
}

function citationExternalUrl(
    citation: ResolvedCitationFence,
    sourceReferenceBySourceId: ReadonlyMap<string, SourceReferenceLink> | undefined
): string | null {
    return citation.externalUrl ?? sourceReferenceBySourceId?.get(citation.sourceId)?.unit.external_url ?? null;
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

function formatPageLabel(range: Pick<PageRange, "startPage" | "endPage">): string {
    return `S. ${formatPageRange(range)}`;
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

export function buildSourceFileCitations(
    citations: ResolvedCitationFence[],
    sourceReferenceBySourceId?: ReadonlyMap<string, SourceReferenceLink>
): SourceFileCitation[] {
    const groups = new Map<string, SourceFileGroup>();

    for (const citation of citations) {
        const fileRef = citationFileRef(citation);
        let group = groups.get(fileRef);
        if (!group) {
            group = { fallback: null, ranges: [] };
            groups.set(fileRef, group);
        }

        const range = citationPageRange(citation);
        if (range) {
            group.ranges.push(range);
        } else {
            group.fallback ??= citation;
        }
    }

    return Array.from(groups.entries()).flatMap(([fileRef, group]): SourceFileCitation[] => {
        const ranges = mergePageRanges(group.ranges);
        if (ranges.length === 0) {
            return group.fallback
                ? [
                      {
                          key: fileRef,
                          fileName: group.fallback.fileName,
                          pageLabel: null,
                          accessibleLabel: group.fallback.fileName,
                          citation: group.fallback,
                          externalUrl: citationExternalUrl(group.fallback, sourceReferenceBySourceId),
                      },
                  ]
                : [];
        }

        return ranges.map((range) => {
            const pageLabel = formatPageLabel(range);
            return {
                key: `${fileRef}:${range.startPage}-${range.endPage}`,
                fileName: range.citation.fileName,
                pageLabel,
                accessibleLabel: `${range.citation.fileName} ${pageLabel}`,
                citation: {
                    ...range.citation,
                    startPage: range.startPage,
                    endPage: range.endPage,
                },
                externalUrl: citationExternalUrl(range.citation, sourceReferenceBySourceId),
            };
        });
    });
}
