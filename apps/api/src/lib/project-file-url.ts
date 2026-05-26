export function getProjectFileProxyPath(
    graphId: string,
    fileId: string,
    options: { fileName?: string | null; page?: number | null; token?: string | null } = {}
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

export function getProjectFileProxyUrl(
    baseUrl: string | undefined,
    graphId: string,
    fileId: string,
    options: { fileName?: string | null; page?: number | null; token?: string | null } = {}
): string {
    const path = getProjectFileProxyPath(graphId, fileId, options);
    if (!baseUrl) {
        return path;
    }

    return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

export function getPublicApiBaseUrl(request: Request, configuredApiUrl?: string): string {
    const origin = getRequestOrigin(request);
    const apiUrl = configuredApiUrl?.trim();

    if (!apiUrl) {
        return origin;
    }

    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(apiUrl)) {
        return apiUrl.replace(/\/+$/u, "");
    }

    const path = apiUrl.startsWith("/") ? apiUrl : `/${apiUrl}`;
    return `${origin}${path.replace(/\/+$/u, "")}`;
}

function getRequestOrigin(request: Request): string {
    const url = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const host = forwardedHost || request.headers.get("host")?.trim();

    if (!host) {
        return url.origin;
    }

    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const protocol = forwardedProto || url.protocol.replace(/:$/u, "");

    return `${protocol}://${host}`;
}
