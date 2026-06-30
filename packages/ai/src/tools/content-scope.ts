import { and, eq, sql, type SQL } from "@kiwi/db/drizzle";
import { filesTable } from "@kiwi/db/tables/graph";

export type GraphContentScope = "documents" | "code" | "all";

export const DEFAULT_GRAPH_CONTENT_SCOPE: GraphContentScope = "documents";

export function normalizeGraphContentScope(scope: GraphContentScope | undefined): GraphContentScope {
    return scope ?? DEFAULT_GRAPH_CONTENT_SCOPE;
}

type FileContentScopeColumns = {
    type: typeof filesTable.type;
};

export function fileContentScopePredicate(
    scope: GraphContentScope | undefined,
    file: FileContentScopeColumns = filesTable
): SQL | undefined {
    switch (normalizeGraphContentScope(scope)) {
        case "all":
            return undefined;
        case "code":
            return eq(file.type, "code");
        case "documents":
            return sql`${file.type} <> 'code'`;
    }
}

export function fileContentScopeSql(scope: GraphContentScope | undefined, alias = "file"): SQL | undefined {
    switch (normalizeGraphContentScope(scope)) {
        case "all":
            return undefined;
        case "code":
            return sql.raw(`${quoteIdentifier(alias)}."file_type" = 'code'`);
        case "documents":
            return sql.raw(`${quoteIdentifier(alias)}."file_type" <> 'code'`);
    }
}

export function scopedVisibleFilePredicate(
    scope: GraphContentScope | undefined,
    visiblePredicate: SQL,
    file: FileContentScopeColumns = filesTable
): SQL {
    return and(visiblePredicate, fileContentScopePredicate(scope, file))!;
}

export function entitySourceScopeSql(scope: GraphContentScope | undefined, entityAlias: string): SQL {
    if (normalizeGraphContentScope(scope) === "all") {
        return sql``;
    }

    const fileScope = fileContentScopeSql(scope, "scope_file");

    return sql`
        and exists (
            select 1
            from sources scope_source
            inner join text_units scope_text_unit on scope_text_unit.id = scope_source.text_unit_id
            inner join files scope_file on scope_file.id = scope_text_unit.file_id
            where scope_source.entity_id = ${sql.raw(`${quoteIdentifier(entityAlias)}."id"`)}
              and scope_source.active = true
              and scope_source.valid_until is null
              and scope_file.deleted = false
              and ${fileScope}
        )
    `;
}

export function relationshipSourceScopeSql(scope: GraphContentScope | undefined, relationshipAlias: string): SQL {
    if (normalizeGraphContentScope(scope) === "all") {
        return sql``;
    }

    const fileScope = fileContentScopeSql(scope, "scope_file");

    return sql`
        and exists (
            select 1
            from sources scope_source
            inner join text_units scope_text_unit on scope_text_unit.id = scope_source.text_unit_id
            inner join files scope_file on scope_file.id = scope_text_unit.file_id
            where scope_source.relationship_id = ${sql.raw(`${quoteIdentifier(relationshipAlias)}."id"`)}
              and scope_source.active = true
              and scope_source.valid_until is null
              and scope_file.deleted = false
              and ${fileScope}
        )
    `;
}

function quoteIdentifier(identifier: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error("Invalid SQL identifier");
    }

    return `"${identifier}"`;
}
