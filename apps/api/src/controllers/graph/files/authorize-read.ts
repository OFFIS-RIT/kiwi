import * as Effect from "effect/Effect";
import { unauthorizedError } from "@kiwi/contracts/errors";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { verifyProjectFileAccessToken } from "../../../lib/project-file-access-token";
import type { AuthUser } from "../../../middleware/auth";
import { assertPermissions } from "../../../middleware/permissions";

export type GraphFileReadParams = {
    graphId: string;
    fileId: string;
};

export function assertCanReadGraphFile(input: {
    request: Request;
    user: AuthUser | null | undefined;
    params: GraphFileReadParams;
}) {
    return Effect.gen(function* () {
        const accessToken = new URL(input.request.url).searchParams.get("token");
        const hasTokenAccess = yield* verifyProjectFileAccessToken(
            accessToken,
            input.params.graphId,
            input.params.fileId
        );

        if (hasTokenAccess) {
            return;
        }

        if (!input.user) {
            return yield* Effect.fail(unauthorizedError());
        }

        yield* assertPermissions(input.request.headers, { graph: ["view"] });
        yield* assertCanViewGraph(input.user, input.params.graphId);
    });
}
