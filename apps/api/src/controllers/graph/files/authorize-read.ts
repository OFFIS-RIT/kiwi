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
        const hasTokenAccess = await verifyProjectFileAccessToken(accessToken, input.params.graphId, input.params.fileId);
    
        if (hasTokenAccess) {
            return;
        }
    
        if (!input.user) {
            throw unauthorizedError();
        }
    
        await assertPermissions(input.request.headers, { graph: ["view"] });
        await assertCanViewGraph(input.user, input.params.graphId);
    });
}
