import * as Effect from "effect/Effect";
import { API_ERROR_CODES, type ApiError, makeApiError } from "@kiwi/contracts/errors";
import { env } from "../../../env";
import { getGraphFileProxyResponse, type GraphFileProxyResult } from "../../../lib/graph/file-proxy";
import type { AuthUser } from "../../../middleware/auth";
import { mapApiError, type RouteStatus, toApiError } from "../../_shared/api-effect";
import { runApiEffect, type ApiServices } from "../../../effect";
import { assertCanReadGraphFile } from "./authorize-read";

export type ServeGraphFileResult = Exclude<GraphFileProxyResult, { status: "not_found" }>;

export function graphFileProxyResponse(result: ServeGraphFileResult) {
    if (result.status === "invalid_range") {
        return new Response(null, {
            status: 416,
            headers: {
                "Accept-Ranges": "bytes",
                "Content-Range": `bytes */${result.size}`,
            },
        });
    }

    return result.response;
}

export function runGraphFileProxyAction<T>(options: {
    status: RouteStatus;
    action: Effect.Effect<T, ApiError, ApiServices>;
    success: (value: T) => unknown;
}) {
    return runApiEffect(
        Effect.match(options.action, {
            onFailure: (error) => mapApiError(options.status, error),
            onSuccess: options.success,
        })
    );
}

export function serveGraphFile(input: {
    graphId: string;
    fileId: string;
    request: Request;
    user: AuthUser | null | undefined;
    head?: boolean;
}): Effect.Effect<ServeGraphFileResult, ApiError, ApiServices> {
    return Effect.mapError(
        Effect.gen(function* () {
            yield* assertCanReadGraphFile({
                request: input.request,
                user: input.user,
                params: { graphId: input.graphId, fileId: input.fileId },
            });

            const result = yield* getGraphFileProxyResponse({
                graphId: input.graphId,
                fileId: input.fileId,
                request: input.request,
                bucket: env.S3_BUCKET,
                head: input.head,
            });

            if (result.status === "not_found") {
                return yield* Effect.fail(makeApiError(404, API_ERROR_CODES.INVALID_FILE_IDS, "File not found"));
            }

            return result;
        }),
        toApiError
    );
}

export function serveGraphFileResponse(input: {
    graphId: string;
    fileId: string;
    request: Request;
    user: AuthUser | null | undefined;
    status: RouteStatus;
    head?: boolean;
}) {
    return runGraphFileProxyAction({
        status: input.status,
        action: serveGraphFile({
            graphId: input.graphId,
            fileId: input.fileId,
            request: input.request,
            user: input.user,
            head: input.head,
        }),
        success: graphFileProxyResponse,
    });
}
