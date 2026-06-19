import * as Effect from "effect/Effect";
import { API_ERROR_CODES, type ApiError, makeApiError } from "@kiwi/contracts/errors";
import type { Database } from "@kiwi/db/effect";
import { loadGraphFileForProxy } from "../../../lib/graph/file-proxy";
import { getProjectFileProxyPath } from "../../../lib/project-file-url";
import type { AuthUser } from "../../../middleware/auth";
import { runGraphFileProxyAction } from "./serve";
import { toApiError, type RouteStatus } from "../../_shared/api-effect";
import { assertCanReadGraphFile } from "./authorize-read";

export function redirectToNamedGraphFile(input: {
    graphId: string;
    fileId: string;
    request: Request;
    user: AuthUser | null | undefined;
}): Effect.Effect<string, ApiError, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
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
        }),
        toApiError
    );
}

export function redirectToNamedGraphFileResponse(input: {
    graphId: string;
    fileId: string;
    request: Request;
    user: AuthUser | null | undefined;
    status: RouteStatus;
}) {
    return runGraphFileProxyAction({
        status: input.status,
        action: redirectToNamedGraphFile({
            graphId: input.graphId,
            fileId: input.fileId,
            request: input.request,
            user: input.user,
        }),
        success: (location) => new Response(null, { status: 307, headers: { Location: location } }),
    });
}
