import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Elysia } from "elysia";

type Scenario =
    | "create-team"
    | "patch-team-no-admin"
    | "patch-users-no-admin"
    | "patch-users-admin-forbidden"
    | "post-admin-forbidden"
    | "delete-admin-forbidden"
    | "delete-team-warning";

const authUser = {
    id: "user-1",
    activeOrganizationId: "org-1",
    activeTeamId: "team-1",
    isSystemAdmin: false,
};

let scenario: Scenario = "create-team";
let dbSelectCount = 0;
let txSelectCount = 0;
const operationLog: string[] = [];
const listedPrefixes: string[] = [];
const deletedS3Keys: string[] = [];

function queryRows(rows: unknown[]) {
    const chain = Object.assign(Effect.succeed(rows), {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        for: () => chain,
        then: <TResult1 = unknown[], TResult2 = never>(
            resolve?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
            reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) => Promise.resolve(rows).then(resolve, reject),
    });

    return chain;
}

function effectWithReturning<T>(value: T, returningValue: unknown[]) {
    return Object.assign(Effect.succeed(value), {
        returning: () => Effect.succeed(returningValue),
    });
}

function runMockDbEffect(thunk: (database: typeof mockDb) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) {
    const result = thunk(mockDb);
    if (Effect.isEffect(result)) {
        return result;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        return Effect.promise(async () => await result);
    }
    return Effect.succeed(result);
}

function nextDbRows() {
    dbSelectCount += 1;

    switch (scenario) {
        case "create-team":
            return [{ userId: "user-1" }, { userId: "user-2" }];
        case "patch-team-no-admin":
        case "patch-users-no-admin":
            return [{ userId: "user-1" }];
        case "patch-users-admin-forbidden":
            return [{ userId: "user-1" }, { userId: "user-2" }];
        case "post-admin-forbidden":
            return [{ userId: "user-2" }];
        case "delete-team-warning":
            if (dbSelectCount === 1) {
                return [{ id: "team-1" }];
            }

            if (dbSelectCount === 2) {
                return [{ id: "graph-1" }, { id: "graph-2" }];
            }

            if (dbSelectCount === 3) {
                return [];
            }

            if (dbSelectCount === 4) {
                return [{ id: "file-1", graphId: "graph-1", key: "graphs/graph-1/file-1.txt" }];
            }

            return [];
        default:
            return [];
    }
}

function nextTxRows() {
    txSelectCount += 1;

    switch (scenario) {
        case "patch-users-no-admin":
            if (txSelectCount === 1) {
                return [{ id: "team-1" }];
            }
            return [
                { user_id: "user-1", role: "admin" },
                { user_id: "user-2", role: "member" },
            ];
        case "patch-users-admin-forbidden":
            if (txSelectCount === 1) {
                return [{ id: "team-1" }];
            }
            return [
                { user_id: "user-1", role: "admin" },
                { user_id: "user-2", role: "member" },
            ];
        case "post-admin-forbidden":
            return [];
        case "delete-admin-forbidden":
            return [
                { user_id: "user-1", role: "admin" },
                { user_id: "user-2", role: "member" },
            ];
        case "delete-team-warning":
            return [{ id: "team-1" }];
        default:
            return [];
    }
}

const transactionDb = {
    select: () => ({ from: () => queryRows(nextTxRows()) }),
    insert: () => ({
        values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
            if (Array.isArray(values) && values[0] && "teamId" in values[0] && "userId" in values[0]) {
                return {
                    returning: () =>
                        Effect.succeed(
                            values.map((value, index) => ({
                                id: `team-member-${index + 1}`,
                                teamId: value.teamId,
                                userId: value.userId,
                                createdAt: new Date(`2024-01-0${index + 1}T00:00:00.000Z`),
                            }))
                        ),
                };
            }

            if (!Array.isArray(values) && "organizationId" in values) {
                return {
                    returning: () => Effect.succeed([{ id: "team-1" }]),
                };
            }

            return Effect.succeed(undefined);
        },
    }),
    update: () => ({
        set: () => ({
            where: () => effectWithReturning(undefined, []),
        }),
    }),
    delete: () => ({
        where: () =>
            Effect.sync(() => {
                if (scenario === "delete-team-warning") {
                    operationLog.push("team-deleted");
                }
            }),
    }),
};

const mockDb = {
    select: () => ({
        from: () => queryRows(nextDbRows()),
    }),
    delete: () => ({
        where: () => Effect.succeed(undefined),
    }),
    insert: () => ({
        values: () => ({
            returning: () => Effect.succeed([]),
        }),
    }),
    update: () => ({
        set: () => ({
            where: () => ({
                returning: () => Effect.succeed([]),
            }),
        }),
    }),
    transaction: (callback: (tx: typeof transactionDb) => unknown) => callback(transactionDb),
};

class MockDatabaseError extends Error {
    constructor(options?: { cause?: unknown }) {
        super("database error");
        this.cause = options?.cause;
    }
}

mock.module("@kiwi/db/effect", () => ({
    Database: Effect.succeed(mockDb),
    DatabaseError: MockDatabaseError,
    DatabaseLayer: Layer.empty,
    runDatabaseEffect: <T, E>(effect: Effect.Effect<T, E, unknown>) =>
        Effect.runPromise(effect as Effect.Effect<T, E, never>),
    tryDb: runMockDbEffect,
    tryDbVoid: (thunk: (database: typeof mockDb) => Effect.Effect<unknown> | PromiseLike<unknown> | unknown) =>
        Effect.asVoid(runMockDbEffect(thunk)),
}));

mock.module("@kiwi/db", () => ({
    betterAuthDb: mockDb,
    db: mockDb,
}));

mock.module("@kiwi/files", () => ({
    FileStorageLive: Layer.empty,
    deleteFile: (key: string) => {
        deletedS3Keys.push(key);
        return scenario === "delete-team-warning" && key.endsWith("extra.txt")
            ? Effect.fail(new Error("delete failed"))
            : Effect.succeed(true);
    },
    listFiles: (prefix: string) => {
        listedPrefixes.push(prefix);
        return scenario === "delete-team-warning" && prefix === "graphs/graph-2/"
            ? Effect.fail(new Error("list failed"))
            : Effect.succeed(prefix === "graphs/graph-1/" ? ["graphs/graph-1/extra.txt"] : []);
    },
    putGraphFile: () => Effect.succeed({ key: "graphs/graph-1/file-1.txt", type: "text/plain" }),
}));

mock.module("@kiwi/logger", () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
}));

mock.module("../../env", () => ({
    env: {
        S3_BUCKET: "bucket",
    },
}));

mock.module("../../lib/graph", () => ({
    collectGraphClosure: () => Effect.succeed(["graph-1", "graph-2"]),
}));

mock.module("../../lib/team/access", () => ({
    requireOrganizationAdmin: () => Effect.succeed({ organizationId: "org-1", role: "admin" }),
    requireOrganizationMembership: () => Effect.succeed({ organizationId: "org-1", role: "admin" }),
    requireTeamAccess: (_user: unknown, teamId: string) =>
        Effect.succeed({
            organizationAdmin: true,
            role: "admin",
            team: { id: teamId, name: "Team", organizationId: "org-1" },
        }),
    requireTeamMemberManageAccess: (_user: unknown, teamId: string) =>
        Effect.succeed({
            organizationAdmin: !(
                scenario === "post-admin-forbidden" ||
                scenario === "patch-users-admin-forbidden" ||
                scenario === "delete-admin-forbidden"
            ),
            role:
                scenario === "post-admin-forbidden" ||
                scenario === "patch-users-admin-forbidden" ||
                scenario === "delete-admin-forbidden"
                    ? "member"
                    : "admin",
            team: { id: teamId, name: "Team", organizationId: "org-1" },
        }),
}));

mock.module("../../lib/workflow-cancellation", () => ({
    cancelActiveFileProcessingWorkflowRuns: (graphId: string) =>
        Effect.sync(() => {
            operationLog.push(`file-workflows-cancelled:${graphId}`);
        }),
    cancelActiveGraphWorkflowRuns: () =>
        Effect.sync(() => {
            operationLog.push("graph-workflows-cancelled");
        }),
}));

mock.module("../../middleware/auth", () => ({
    authMiddleware: new Elysia({ name: "team-test-auth" }).derive({ as: "scoped" }, () => ({
        session: null,
        user: authUser,
    })),
}));

mock.module("../../middleware/permissions", () => ({
    requirePermissions: () => () => undefined,
}));

// Dynamic import is required because this test intentionally mocks route dependencies before module evaluation.
const { teamRoute } = await import("../team");

describe("team route characterization", () => {
    beforeEach(() => {
        scenario = "create-team";
        dbSelectCount = 0;
        txSelectCount = 0;
        operationLog.length = 0;
        listedPrefixes.length = 0;
        deletedS3Keys.length = 0;
    });

    test("create team preserves an admin by forcing the requester to admin", async () => {
        const response = await new Elysia().use(teamRoute).handle(
            new Request("http://localhost/teams/", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    name: "Infra",
                    users: [
                        { user_id: "user-1", role: "member" },
                        { user_id: "user-2", role: "member" },
                    ],
                }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(201);
        expect(body.status).toBe("success");
        expect(body.data.team).toEqual({ id: "team-1" });
        expect(body.data.users).toEqual([
            {
                teamId: "team-1",
                userId: "user-1",
                role: "admin",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: null,
            },
            {
                teamId: "team-1",
                userId: "user-2",
                role: "member",
                createdAt: "2024-01-02T00:00:00.000Z",
                updatedAt: null,
            },
        ]);
    });

    test("patch team users rejects updates that would remove every admin", async () => {
        scenario = "patch-team-no-admin";

        const response = await new Elysia().use(teamRoute).handle(
            new Request("http://localhost/teams/team-1", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    users: [{ user_id: "user-1", role: "member" }],
                }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.status).toBe("error");
        expect(body.code).toBe("INVALID_TEAM_MEMBERS");
    });

    test("bulk team-user updates reject payloads that would remove every admin", async () => {
        scenario = "patch-users-no-admin";

        const response = await new Elysia().use(teamRoute).handle(
            new Request("http://localhost/teams/team-1/users", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    users: [{ user_id: "user-1", role: "member" }],
                }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.status).toBe("error");
        expect(body.code).toBe("INVALID_TEAM_MEMBERS");
    });

    test("non-organization-admin cannot reassign admin memberships in bulk updates", async () => {
        scenario = "patch-users-admin-forbidden";

        const response = await new Elysia().use(teamRoute).handle(
            new Request("http://localhost/teams/team-1/users", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    users: [
                        { user_id: "user-1", role: "member" },
                        { user_id: "user-2", role: "admin" },
                    ],
                }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.status).toBe("error");
        expect(body.code).toBe("FORBIDDEN");
    });

    test("non-organization-admin cannot add an admin role", async () => {
        scenario = "post-admin-forbidden";

        const response = await new Elysia().use(teamRoute).handle(
            new Request("http://localhost/teams/team-1/users", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    user_id: "user-2",
                    role: "admin",
                }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.status).toBe("error");
        expect(body.code).toBe("FORBIDDEN");
    });

    test("non-organization-admin cannot remove the last admin by deleting that membership", async () => {
        scenario = "delete-admin-forbidden";

        const response = await new Elysia().use(teamRoute).handle(
            new Request("http://localhost/teams/team-1/users/user-1", {
                method: "DELETE",
            })
        );
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.status).toBe("error");
        expect(body.code).toBe("FORBIDDEN");
    });

    test("delete team cancels workflows before delete and keeps warning fields when S3 cleanup is partial", async () => {
        scenario = "delete-team-warning";

        const response = await new Elysia().use(teamRoute).handle(
            new Request("http://localhost/teams/team-1", {
                method: "DELETE",
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(body.data).toEqual({
            teamId: "team-1",
            deletedGraphCount: 2,
            deletedFileCount: 1,
            s3Cleanup: {
                attemptedKeyCount: 2,
                failedKeyCount: 2,
            },
            warnings: ["Some S3 objects could not be deleted after the team was removed"],
        });
        expect(operationLog).toEqual(["graph-workflows-cancelled", "file-workflows-cancelled:graph-1", "team-deleted"]);
        expect(listedPrefixes).toEqual(["graphs/graph-1/", "graphs/graph-2/"]);
        expect(deletedS3Keys).toEqual(["graphs/graph-1/file-1.txt", "graphs/graph-1/extra.txt"]);
    });
});
