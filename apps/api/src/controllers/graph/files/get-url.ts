import * as Effect from "effect/Effect";
import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadGraphFileByKey } from "../../../lib/graph/file-proxy";
import { getProjectFileProxyPath } from "../../../lib/project-file-url";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";

export function getGraphFileUrl(input: { user: AuthUser; graphId: string; fileKey: string }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                yield* assertCanViewGraph(input.user, input.graphId);

                const file = yield* loadGraphFileByKey(input.graphId, input.fileKey);
                if (!file) {
                    return yield* Effect.fail(makeApiError(400, API_ERROR_CODES.INVALID_FILE_IDS, "Invalid file IDs"));
                }

                return { url: getProjectFileProxyPath(input.graphId, file.id, { fileName: file.name }) };
            }),
            (defect) => Effect.fail(defect)
        ),
        toApiError
    );
}
