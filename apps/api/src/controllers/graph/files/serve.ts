import * as Effect from "effect/Effect";
import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import { env } from "../../../env";
import { getGraphFileProxyResponse, type GraphFileProxyResult } from "../../../lib/graph/file-proxy";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";
import { assertCanReadGraphFile } from "./authorize-read";

export type ServeGraphFileResult = Exclude<GraphFileProxyResult, { status: "not_found" }>;

export function serveGraphFile(input: {
    graphId: string;
    fileId: string;
    request: Request;
    user: AuthUser | null | undefined;
    head?: boolean;
}) {
    return tryApiPromise(async (): Promise<ServeGraphFileResult> => {
        await assertCanReadGraphFile({
            request: input.request,
            user: input.user,
            params: { graphId: input.graphId, fileId: input.fileId },
        });

        const result = await Effect.runPromise(getGraphFileProxyResponse({
            graphId: input.graphId,
            fileId: input.fileId,
            request: input.request,
            bucket: env.S3_BUCKET,
            head: input.head,
        }));

        if (result.status === "not_found") {
            throw makeApiError(404, API_ERROR_CODES.INVALID_FILE_IDS, "File not found");
        }

        return result;
    });
}
