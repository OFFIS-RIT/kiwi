import * as Effect from "effect/Effect";
import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import { DatabaseLayer } from "@kiwi/db/effect";
import { env } from "../../../env";
import { getGraphFileProxyResponse, type GraphFileProxyResult } from "../../../lib/graph/file-proxy";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";
import { assertCanReadGraphFile } from "./authorize-read";

export type ServeGraphFileResult = Exclude<GraphFileProxyResult, { status: "not_found" }>;

export function serveGraphFile(input: {
    graphId: string;
    fileId: string;
    request: Request;
    user: AuthUser | null | undefined;
    head?: boolean;
}) {
    return Effect.provide(
        Effect.mapError(Effect.catchDefect(Effect.gen(function* () {
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
        }), (defect) => Effect.fail(defect)), toApiError),
        DatabaseLayer
    );
}
