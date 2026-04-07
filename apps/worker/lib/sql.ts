import { sql } from "drizzle-orm";

export const EMPTY_VECTOR_SQL = sql.raw("('[0' || repeat(',0', 4095) || ']')::vector");

export function textArray(values: string[]) {
    if (values.length === 0) {
        return sql`ARRAY[]::text[]`;
    }

    return sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `
    )}]::text[]`;
}

export function normalizedEntityName(column: string) {
    return `upper(trim(regexp_replace(regexp_replace(regexp_replace(${column}, '&', ' AND ', 'g'), '[^[:alnum:]]+', ' ', 'g'), '\\s+', ' ', 'g')))`;
}
