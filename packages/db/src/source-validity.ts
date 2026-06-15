import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { filesTable, sourcesTable } from "./tables/graph";

type SourceValidityColumns = {
    active: typeof sourcesTable.active;
    validUntil: typeof sourcesTable.validUntil;
};

type FileVisibilityColumns = {
    deleted: typeof filesTable.deleted;
};

export function currentSourcePredicate(source: SourceValidityColumns = sourcesTable): SQL {
    return and(eq(source.active, true), isNull(source.validUntil))!;
}

export function unexpiredSourcePredicate(source: Pick<SourceValidityColumns, "validUntil"> = sourcesTable): SQL {
    return isNull(source.validUntil);
}

export function visibleFilePredicate(file: FileVisibilityColumns = filesTable): SQL {
    return eq(file.deleted, false);
}

export function currentSourceSql(alias = "source"): SQL {
    const quoted = quoteIdentifier(alias);
    return sql.raw(`${quoted}."active" = true AND ${quoted}."valid_until" IS NULL`);
}

export function visibleFileSql(alias = "file"): SQL {
    return sql.raw(`${quoteIdentifier(alias)}."deleted" = false`);
}

function quoteIdentifier(identifier: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error("Invalid SQL identifier");
    }

    return `"${identifier}"`;
}
