import { getProjectFileProxyPath, type ProjectFileProxyPathOptions } from "@kiwi/files/project-file-proxy-path";

export { getProjectFileProxyPath } from "@kiwi/files/project-file-proxy-path";

export function getProjectFileProxyUrl(
    baseUrl: string | undefined,
    graphId: string,
    fileId: string,
    options: ProjectFileProxyPathOptions = {}
): string {
    const path = getProjectFileProxyPath(graphId, fileId, options);
    if (!baseUrl) {
        return path;
    }

    return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

export function getPublicApiBaseUrl(request: Request, configuredApiUrl?: string): string {
    const apiUrl = configuredApiUrl?.trim();

    if (apiUrl && /^[a-z][a-z0-9+.-]*:\/\//iu.test(apiUrl)) {
        return apiUrl.replace(/\/+$/u, "");
    }

    const origin = new URL(request.url).origin;
    if (!apiUrl) {
        return origin;
    }

    const path = apiUrl.startsWith("/") ? apiUrl : `/${apiUrl}`;
    return `${origin}${path.replace(/\/+$/u, "")}`;
}
