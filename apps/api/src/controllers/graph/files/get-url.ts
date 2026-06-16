import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import type { GraphFileDownloadSuccessData } from "@kiwi/contracts/graphs";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadGraphFileByKey } from "../../../lib/graph/file-proxy";
import { getProjectFileProxyPath } from "../../../lib/project-file-url";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";

export function getGraphFileUrl(input: { user: AuthUser; graphId: string; fileKey: string }) {
    return tryApiPromise(async (): Promise<GraphFileDownloadSuccessData> => {
        await assertCanViewGraph(input.user, input.graphId);

        const file = await loadGraphFileByKey(input.graphId, input.fileKey);
        if (!file) {
            throw makeApiError(400, API_ERROR_CODES.INVALID_FILE_IDS, "Invalid file IDs");
        }

        return { url: getProjectFileProxyPath(input.graphId, file.id, { fileName: file.name }) };
    });
}
