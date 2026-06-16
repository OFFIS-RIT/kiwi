import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import { loadGraphFileForProxy } from "../../../lib/graph/file-proxy";
import { getProjectFileProxyPath } from "../../../lib/project-file-url";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";
import { assertCanReadGraphFile } from "./authorize-read";

export function redirectToNamedGraphFile(input: {
    graphId: string;
    fileId: string;
    request: Request;
    user: AuthUser | null | undefined;
}) {
    return tryApiPromise(async (): Promise<string> => {
        await assertCanReadGraphFile({
            request: input.request,
            user: input.user,
            params: { graphId: input.graphId, fileId: input.fileId },
        });

        const file = await loadGraphFileForProxy(input.graphId, input.fileId);
        if (!file) {
            throw makeApiError(404, API_ERROR_CODES.INVALID_FILE_IDS, "File not found");
        }

        const requestUrl = new URL(input.request.url);
        return `${getProjectFileProxyPath(input.graphId, input.fileId, { fileName: file.name })}${requestUrl.search}`;
    });
}
