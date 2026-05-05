import Fuse from "fuse.js";

export function normalizeUserSearch(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[-_/]+/g, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function compactUserSearch(value: string): string {
    return normalizeUserSearch(value).replace(/\s+/g, "");
}

export function matchesNormalizedTokens(query: string, normalizedName: string): boolean {
    if (!query) {
        return false;
    }

    const parts = query.split(" ").filter(Boolean);
    if (parts.length === 0) {
        return false;
    }

    let searchStartIndex = 0;
    for (const part of parts) {
        const matchIndex = normalizedName.indexOf(part, searchStartIndex);
        if (matchIndex === -1) {
            return false;
        }
        searchStartIndex = matchIndex + part.length;
    }

    return true;
}

export type SearchableFields = {
    name: string;
    email: string;
    normalizedName: string;
    compactName: string;
};

export function createSearchIndex<T extends SearchableFields>(items: T[]): Fuse<T> {
    return new Fuse(items, {
        keys: ["name", "normalizedName", "compactName", "email"],
        threshold: 0.4,
        distance: 100,
        ignoreLocation: true,
        minMatchCharLength: 1,
    });
}

export function fuzzySearchUsers<T extends SearchableFields>(items: T[], index: Fuse<T>, query: string): T[] {
    const normalizedQuery = normalizeUserSearch(query);
    const compactQuery = compactUserSearch(query);

    if (!normalizedQuery) {
        return items;
    }

    const sequentialMatches = items.filter(
        (item) =>
            item.normalizedName.includes(normalizedQuery) ||
            item.compactName.includes(compactQuery) ||
            matchesNormalizedTokens(normalizedQuery, item.normalizedName)
    );

    const fuzzyMatches = index.search(normalizedQuery).map((r) => r.item);
    const compactMatches =
        compactQuery && compactQuery !== normalizedQuery ? index.search(compactQuery).map((r) => r.item) : [];

    const seen = new Set<T>();
    const result: T[] = [];
    for (const item of [...sequentialMatches, ...fuzzyMatches, ...compactMatches]) {
        if (!seen.has(item)) {
            seen.add(item);
            result.push(item);
        }
    }
    return result;
}
