export type ProjectFileProxyPathOptions = {
    fileName?: string | null;
    page?: number | null;
    token?: string | null;
};

export function getProjectFileProxyPath(
    graphId: string,
    fileId: string,
    options: ProjectFileProxyPathOptions = {}
): string {
    const fileName = options.fileName?.trim();
    const fileNamePath = fileName ? `/${encodeURIComponent(fileName)}` : "";
    const path = `/graphs/${encodeURIComponent(graphId)}/files/${encodeURIComponent(fileId)}${fileNamePath}`;
    const searchParams = new URLSearchParams();
    if (options.token) {
        searchParams.set("token", options.token);
    }

    const query = searchParams.toString();
    const pathWithQuery = query ? `${path}?${query}` : path;
    const page = options.page;

    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
        return pathWithQuery;
    }

    return `${pathWithQuery}#page=${page}`;
}
