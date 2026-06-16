import Elysia from "elysia";
import z from "zod";
import {
    TeamAddUserInputSchema,
    TeamCreateInputSchema,
    TeamPatchInputSchema,
    TeamUpdateUsersInputSchema,
} from "@kiwi/contracts/teams";
import { successResponse } from "@kiwi/contracts/errors";
import { asApiSchema } from "@kiwi/contracts/schema";
import { runApiAction } from "../controllers/_shared/api-effect";
import { addTeamUser } from "../controllers/team/users/add";
import { createTeam } from "../controllers/team/create";
import { deleteTeam } from "../controllers/team/delete";
import { listAvailableUsers } from "../controllers/team/users/list-available";
import { listTeamUsers } from "../controllers/team/users/list";
import { listTeams } from "../controllers/team/list";
import { patchTeam } from "../controllers/team/patch";
import { removeTeamUser } from "../controllers/team/users/remove";
import { updateTeamUsers } from "../controllers/team/users/update";
import { authMiddleware } from "../middleware/auth";

const teamIdParamsSchema = z.object({
    id: z.string(),
});

export const teamRoute = new Elysia({ prefix: "/teams" })
    .use(authMiddleware)
    .get("/", ({ status, user }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => listTeams({ user: currentUser }),
            success: (value) => status(200, successResponse(value)),
        })
    )
    .post(
        "/",
        ({ status, body, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    createTeam({
                        user: currentUser,
                        body: {
                            name: body.name,
                            users: body.users?.map((teamUser) => ({ ...teamUser })),
                        },
                    }),
                success: (value) => status(201, successResponse(value)),
            }),
        {
            body: asApiSchema(TeamCreateInputSchema),
        }
    )
    .get(
        "/:id/available-users",
        ({ status, params, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => listAvailableUsers({ user: currentUser, teamId: params.id }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: teamIdParamsSchema,
        }
    )
    .get(
        "/:id/users",
        ({ status, params, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => listTeamUsers({ user: currentUser, teamId: params.id }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: teamIdParamsSchema,
        }
    )
    .post(
        "/:id/users",
        ({ status, params, body, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => addTeamUser({ user: currentUser, teamId: params.id, body }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: teamIdParamsSchema,
            body: asApiSchema(TeamAddUserInputSchema),
        }
    )
    .patch(
        "/:id/users",
        ({ status, params, body, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    updateTeamUsers({
                        user: currentUser,
                        teamId: params.id,
                        body: { users: body.users.map((teamUser) => ({ ...teamUser })) },
                    }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: teamIdParamsSchema,
            body: asApiSchema(TeamUpdateUsersInputSchema),
        }
    )
    .delete(
        "/:id/users/:userId",
        ({ status, params, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    removeTeamUser({ user: currentUser, teamId: params.id, userId: params.userId }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: z.object({
                id: z.string(),
                userId: z.string(),
            }),
        }
    )
    .patch(
        "/:id",
        ({ status, body, params, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    patchTeam({
                        user: currentUser,
                        teamId: params.id,
                        body: {
                            name: body.name,
                            users: body.users?.map((teamUser) => ({ ...teamUser })),
                        },
                    }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: teamIdParamsSchema,
            body: asApiSchema(TeamPatchInputSchema),
        }
    )
    .delete(
        "/:id",
        ({ status, params, user }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => deleteTeam({ user: currentUser, teamId: params.id }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: teamIdParamsSchema,
        }
    );
