import * as Effect from "effect/Effect";
import { unauthorizedError } from "@kiwi/contracts/errors";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { verifyProjectFileAccessToken } from "../../../lib/project-file-access-token";
import type { AuthUser } from "../../../middleware/auth";
import { assertPermissions } from "../../../middleware/permissions";
import { tryApiPromise } from "../../_shared/api-effect";

export type GraphFileReadParams = {
    graphId: string;
    fileId: string;
};

export function assertCanReadGraphFile(input: {
    request: Request;
    user: AuthUser | null | undefined;
    params: GraphFileReadParams;
}) {
    return tryApiPromise(async () => {
        const accessToken = new URL(input.request.url).searchParams.get("token");
        const hasTokenAccess = await Effect.runPromise(
            verifyProjectFileAccessToken(accessToken, input.params.graphId, input.params.fileId)
        );
    
        if (hasTokenAccess) {
            return;
        }
    
        if (!input.user) {
            throw unauthorizedError();
        }
    
        await Effect.runPromise(assertPermissions(input.request.headers, { graph: ["view"] }));
        await Effect.runPromise(assertCanViewGraph(input.user, input.params.graphId));
    });
}
