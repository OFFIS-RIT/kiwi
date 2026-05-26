import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type DbRow = Record<string, unknown>;

let dbResults: DbRow[][] = [];

function queueDbResults(...results: DbRow[][]) {
    dbResults.push(...results);
}

function createSelectQuery() {
    const query = {
        from: () => query,
        leftJoin: () => query,
        where: () => query,
        limit: async () => {
            const result = dbResults.shift();
            if (!result) {
                throw new Error("No queued DB result");
            }

            return result;
        },
    };

    return query;
}

mock.module("@kiwi/auth/server", () => ({
    getDefaultOrganizationId: () => "org-1",
}));

mock.module("@kiwi/db", () => ({
    db: {
        select: () => createSelectQuery(),
    },
}));

const { API_ERROR_CODES } = await import("../../types");
const {
    assertCanCreateTopLevelGraph,
    assertCanCreateUnderParentGraph,
    assertCanManageGraphFiles,
    assertCanPatchGraph,
    assertCanViewGraph,
} = await import("../graph-access");

type AuthUser = Parameters<typeof assertCanViewGraph>[0];
type GraphRecord = Awaited<ReturnType<typeof assertCanViewGraph>>;

const team = {
    id: "team-1",
    name: "Team",
    organizationId: "org-1",
};

const organization = {
    id: "org-1",
};

const organizationAdminMembership = {
    organizationId: "org-1",
    userId: "user-1",
    role: "admin",
};

const organizationMemberMembership = {
    organizationId: "org-1",
    userId: "user-1",
    role: "member",
};

const teamAdminRole = {
    role: "admin",
};

const teamModeratorRole = {
    role: "moderator",
};

const teamMemberRole = {
    role: "member",
};

function buildUser(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
        id: "user-1",
        name: "User",
        email: "user@example.com",
        emailVerified: true,
        image: null,
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        activeOrganizationId: "org-1",
        activeTeamId: null,
        isSystemAdmin: false,
        ...overrides,
    } as AuthUser;
}

function buildTeamGraph(overrides: Partial<GraphRecord> = {}): GraphRecord {
    return {
        id: "graph-1",
        name: "Graph",
        description: null,
        organizationId: "org-1",
        teamId: "team-1",
        userId: null,
        graphId: null,
        hidden: false,
        state: "ready",
        ...overrides,
    };
}

function queueTeamGraphAccess(graph: GraphRecord, membership: DbRow | null, teamRole?: DbRow) {
    queueDbResults([graph], [graph], [team], membership ? [membership] : []);
    if (teamRole) {
        queueDbResults([teamRole]);
    }
}

describe("graph access", () => {
    beforeEach(() => {
        dbResults = [];
    });

    afterEach(() => {
        expect(dbResults).toHaveLength(0);
    });

    test("allows organization admins to mutate team graphs", async () => {
        const graph = buildTeamGraph();
        queueTeamGraphAccess(graph, organizationAdminMembership);

        await expect(assertCanPatchGraph(buildUser(), graph.id)).resolves.toEqual(graph);
    });

    test("allows team admins to mutate team graphs", async () => {
        const graph = buildTeamGraph();
        queueTeamGraphAccess(graph, organizationMemberMembership, teamAdminRole);

        await expect(assertCanPatchGraph(buildUser(), graph.id)).resolves.toEqual(graph);
    });

    test("allows team moderators to manage graph files but not mutate graphs", async () => {
        const graph = buildTeamGraph();
        queueTeamGraphAccess(graph, organizationMemberMembership, teamModeratorRole);

        await expect(assertCanManageGraphFiles(buildUser(), graph.id)).resolves.toEqual(graph);

        queueTeamGraphAccess(graph, organizationMemberMembership, teamModeratorRole);
        await expect(assertCanPatchGraph(buildUser(), graph.id)).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("allows team members to view team graphs without managing files", async () => {
        const graph = buildTeamGraph();
        queueTeamGraphAccess(graph, organizationMemberMembership, teamMemberRole);

        await expect(assertCanViewGraph(buildUser(), graph.id)).resolves.toEqual(graph);

        queueTeamGraphAccess(graph, organizationMemberMembership, teamMemberRole);
        await expect(assertCanManageGraphFiles(buildUser(), graph.id)).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("treats system admins as organization admins for existing organizations", async () => {
        const graph = buildTeamGraph();
        queueDbResults([graph], [graph], [team], [], [organization]);

        await expect(
            assertCanPatchGraph(buildUser({ isSystemAdmin: true, role: "admin" }), graph.id)
        ).resolves.toEqual(graph);
    });

    test("treats system admins as organization admins over manual member rows", async () => {
        const graph = buildTeamGraph({ teamId: null });
        queueDbResults([graph], [graph], [organizationMemberMembership]);

        await expect(
            assertCanPatchGraph(buildUser({ isSystemAdmin: true, role: "admin" }), graph.id)
        ).resolves.toEqual(graph);
    });

    test("rejects file management and mutation for personal graphs", async () => {
        const graph = buildTeamGraph({ organizationId: null, teamId: null, userId: "user-1" });
        queueDbResults([graph], [graph]);

        await expect(assertCanPatchGraph(buildUser(), graph.id)).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);

        queueDbResults([graph], [graph]);
        await expect(assertCanManageGraphFiles(buildUser(), graph.id)).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("allows organization admins to manage organization graphs", async () => {
        const graph = buildTeamGraph({ teamId: null });

        queueDbResults([graph], [graph], [organizationAdminMembership]);

        await expect(assertCanPatchGraph(buildUser(), graph.id)).resolves.toEqual(graph);

        queueDbResults([graph], [graph], [organizationAdminMembership]);
        await expect(assertCanManageGraphFiles(buildUser(), graph.id)).resolves.toEqual(graph);

        queueDbResults([graph], [organizationAdminMembership]);
        await expect(assertCanCreateUnderParentGraph(buildUser(), graph.id)).resolves.toBeUndefined();
    });

    test("limits organization members to viewing organization graphs", async () => {
        const graph = buildTeamGraph({ teamId: null });

        queueDbResults([graph], [graph], [organizationMemberMembership]);
        await expect(assertCanViewGraph(buildUser(), graph.id)).resolves.toEqual(graph);

        queueDbResults([graph], [graph], [organizationMemberMembership]);

        await expect(assertCanPatchGraph(buildUser(), graph.id)).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);

        queueDbResults([graph], [graph], [organizationMemberMembership]);
        await expect(assertCanManageGraphFiles(buildUser(), graph.id)).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);

        queueDbResults([graph], [organizationMemberMembership]);
        await expect(assertCanCreateUnderParentGraph(buildUser(), graph.id)).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("allows top-level graph creation for organization admins", async () => {
        queueDbResults([organizationAdminMembership]);

        await expect(assertCanCreateTopLevelGraph(buildUser())).resolves.toEqual(organizationAdminMembership);
    });

    test("rejects top-level graph creation for organization members", async () => {
        queueDbResults([organizationMemberMembership]);

        await expect(assertCanCreateTopLevelGraph(buildUser())).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });
});
