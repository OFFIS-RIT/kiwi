import { sql, type SQL } from "drizzle-orm";

export const MIN_SEMANTIC_SCORE = 0.02;
export const MIN_KEYWORD_BOOST = 0.08;
export const KEYWORD_WEIGHT = 0.15;
export const EXACT_BOOST = 0.2;
export const PREFIX_BOOST = 0.1;

export type RankCursor = {
    score: number;
    id: string;
};

export function normalizeTerms(values: string[]) {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function truncateWords(value: string, maxWords = 40) {
    const normalized = value.replace(/\s+/g, " ").trim();
    const words = normalized.length > 0 ? normalized.split(" ") : [];

    return words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}...` : normalized;
}

export function encodeCursor(cursor: RankCursor) {
    return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined, label: string): RankCursor | undefined {
    if (!cursor) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));

        if (
            !parsed ||
            typeof parsed !== "object" ||
            typeof parsed.id !== "string" ||
            typeof parsed.score !== "number" ||
            !Number.isFinite(parsed.score)
        ) {
            throw new Error("Invalid cursor");
        }

        return parsed;
    } catch {
        throw new Error(`Invalid ${label} cursor`);
    }
}

export function greatest(expressions: SQL[]) {
    if (expressions.length === 0) {
        return sql`0::double precision`;
    }

    if (expressions.length === 1) {
        return expressions[0]!;
    }

    return sql`greatest(${sql.join(expressions, sql`, `)})`;
}
