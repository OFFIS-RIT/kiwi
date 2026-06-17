import * as Effect from "effect/Effect";
import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import { DatabaseLayer } from "@kiwi/db/effect";
import { loadGraphFileForProxy } from "../../../lib/graph/file-proxy";
import { getProjectFileProxyPath } from "../../../lib/project-file-url";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";
import { assertCanReadGraphFile } from "./authorize-read";

export function redirectToNamedGraphFile(input: {
    graphId: string;
    fileId: string;
    request: Request;
    user: AuthUser | null | undefined;
}) {
    return Effect.provide(
        Effect.mapError(Effect.catchDefect(Effect.gen(function* () {
            yield* assertCanReadGraphFile({
                request: input.request,
                user: input.user,
                params: { graphId: input.graphId, fileId: input.fileId },
            });

            const file = yield* loadGraphFileForProxy(input.graphId, input.fileId);
            if (!file) {
                return yield* Effect.fail(makeApiError(404, API_ERROR_CODES.INVALID_FILE_IDS, "File not found"));
            }

            const requestUrl = new URL(input.request.url);
            return `${getProjectFileProxyPath(input.graphId, input.fileId, { fileName: file.name })}${requestUrl.search}`;
        }), (defect) => Effect.fail(defect)), toApiError),
        DatabaseLayer
    );
}
