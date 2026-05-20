export function rowsToMarkdown(rows: string[][]): string {
    if (rows.length === 0) {
        return "";
    }

    const header = rows[0] ?? [];
    const separator = Array.from({ length: header.length }, () => "---");
    const body = rows.slice(1);

    return [markdownRow(header), markdownRow(separator), ...body.map((row) => markdownRow(row))].join("\n");
}

function markdownRow(row: string[]): string {
    return `| ${row.map(escapeMarkdownTableCell).join(" | ")} |`;
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|");
}
