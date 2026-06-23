import { successResponse } from "@kiwi/contracts/errors";
import { Elysia, t } from "elysia";
import { runApiAction } from "../controllers/_shared/api-effect";
import { getGraphWorkerEta } from "../controllers/workers/eta";
import { authMiddleware } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";

export const workersRoute = new Elysia({ prefix: "/workers" }).use(authMiddleware).get(
    "/eta/graphs/:graphId",
    ({ params, user, status }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => getGraphWorkerEta({ user: currentUser, graphId: params.graphId }),
            success: (value) => status(200, successResponse(value)),
        }),
    {
        params: t.Object({
            graphId: t.String(),
        }),
        beforeHandle: requirePermissions({
            graph: ["view"],
        }),
    }
);
