import * as Effect from "effect/Effect";
import { roleIncludes } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import { memberTable, organizationTable, teamTable } from "@kiwi/db/tables/auth";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AuthUser } from "../middleware/auth";
import { API_ERROR_CODES } from "../types";
import { getGraphById, resolveGraphOwnerRoot, type GraphRecord } from "./graph/access";
import { getOrganizationMembership, getTeamRole } from "./team/access";

const targetMemberTable = alias(memberTable, "target_member");
const ADMIN_ROLE_PATTERN = "(^|,)[[:space:]]*admin[[:space:]]*(,|$)";

type TeamRecord = {
    id: string;
    organizationId: string;
};

function getTeamById(teamId: string): Effect.Effect<TeamRecord | null, unknown> {
    return Effect.tryPromise(async () => {
        const [team] = await db
            .select({
                id: teamTable.id,
                organizationId: teamTable.organizationId,
            })
            .from(teamTable)
            .where(eq(teamTable.id, teamId))
            .limit(1);

        return team ?? null;
    });
}

function getOrganizationAccess(user: AuthUser, organizationId: string) {
    return Effect.gen(function* () {
        const membership = yield* getOrganizationMembership(user, organizationId);
        return {
            membership,
            admin: roleIncludes(membership?.role, "admin"),
        };
    });
}

export function assertCanManageUserPrompts(user: AuthUser, targetUserId: string) {
    if (targetUserId === user.id || user.isSystemAdmin) {
        return Effect.void;
    }

    return Effect.gen(function* () {
        const [adminMembership] = yield* Effect.tryPromise(() =>
            db
                .select({ userId: memberTable.userId })
                .from(memberTable)
                .innerJoin(
                    targetMemberTable,
                    and(
                        eq(targetMemberTable.organizationId, memberTable.organizationId),
                        eq(targetMemberTable.userId, targetUserId)
                    )
                )
                .where(and(eq(memberTable.userId, user.id), sql<boolean>`${memberTable.role} ~ ${ADMIN_ROLE_PATTERN}`))
                .limit(1)
        );

        if (!adminMembership) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }
    });
}

export function assertCanManageOrganizationPrompts(user: AuthUser, organizationId: string) {
    return Effect.gen(function* () {
        // Permission gate first: only system admins may ever reach this resource,
        // so non-admins must not be able to probe organization ID validity via
        // the 403/404 distinction.
        if (!user.isSystemAdmin) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        const [organization] = yield* Effect.tryPromise(() =>
            db
                .select({ id: organizationTable.id })
                .from(organizationTable)
                .where(eq(organizationTable.id, organizationId))
                .limit(1)
        );

        if (!organization) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.ORGANIZATION_NOT_FOUND));
        }

        return organization;
    });
}

export function assertCanManageTeamPrompts(user: AuthUser, teamId: string) {
    return Effect.gen(function* () {
        const team = yield* getTeamById(teamId);
        if (!team) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.TEAM_NOT_FOUND));
        }

        if (user.isSystemAdmin) {
            return team;
        }

        const access = yield* getOrganizationAccess(user, team.organizationId);
        if (access.admin) {
            return team;
        }

        if (!access.membership) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        const teamRole = yield* getTeamRole(user.id, team.id);
        if (teamRole !== "admin") {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        return team;
    });
}

export function assertCanManageGraphPrompts(user: AuthUser, graphId: string): Effect.Effect<GraphRecord, unknown> {
    return Effect.gen(function* () {
        const graph = yield* getGraphById(graphId);
        if (!graph) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.GRAPH_NOT_FOUND));
        }

        if (user.isSystemAdmin) {
            return graph;
        }

        const rootOwner = yield* resolveGraphOwnerRoot(graph.id);
        if (rootOwner.mode === "user") {
            if (rootOwner.userId === user.id) {
                return graph;
            }

            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        const access = yield* getOrganizationAccess(user, rootOwner.organizationId);
        if (access.admin) {
            return graph;
        }

        if (rootOwner.mode !== "team") {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        if (!access.membership) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        const teamRole = yield* getTeamRole(user.id, rootOwner.teamId);
        if (teamRole !== "admin") {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }

        return graph;
    });
}
