import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

export const tsvector = customType<{ data: string; driverData: string }>({
    dataType() {
        return "tsvector";
    },
});

export function weightedTsvectorGenerated(columns: string[], language = "simple") {
    const expressions = columns.map((column, index) => {
        const weight = String.fromCharCode(index + 65);
        return `setweight(to_tsvector('${language}', coalesce(${column}, '')), '${weight}')`;
    });

    return sql.raw(expressions.join(" || "));
}
