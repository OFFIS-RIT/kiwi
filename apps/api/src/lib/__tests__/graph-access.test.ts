import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";

type DbRow = Record<string, unknown>;

let dbResults: DbRow[][] = [];

function queueDbResults(...results: DbRow[][]) {
    dbResults.push(...results);
}

function createSelectQuery() {
    const query = {
        from: () => query,
        innerJoin: () => query,
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
    assertCanManageGraphSuggestions,
    assertCanPatchGraph,
    assertCanViewGraph,
} = await import("../graph/access");
const { assertCanManageGraphPrompts, assertCanManageOrganizationPrompts, assertCanManageUserPrompts } =
    await import("../prompt-access");

type AuthUser = Parameters<typeof assertCanViewGraph>[0];
type GraphRecord = Effect.Success<ReturnType<typeof assertCanViewGraph>>;

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

        await expect(Effect.runPromise(assertCanPatchGraph(buildUser(), graph.id))).resolves.toEqual(graph);
    });

    test("allows team admins to mutate team graphs", async () => {
        const graph = buildTeamGraph();
        queueTeamGraphAccess(graph, organizationMemberMembership, teamAdminRole);

        await expect(Effect.runPromise(assertCanPatchGraph(buildUser(), graph.id))).resolves.toEqual(graph);
    });

    test("allows team moderators to manage team graphs and graph files", async () => {
        const graph = buildTeamGraph();
        queueTeamGraphAccess(graph, organizationMemberMembership, teamModeratorRole);

        await expect(Effect.runPromise(assertCanManageGraphFiles(buildUser(), graph.id))).resolves.toEqual(graph);

        queueTeamGraphAccess(graph, organizationMemberMembership, teamModeratorRole);
        await expect(Effect.runPromise(assertCanPatchGraph(buildUser(), graph.id))).resolves.toEqual(graph);

        queueDbResults([graph], [team], [organizationMemberMembership], [teamModeratorRole]);
        await expect(Effect.runPromise(assertCanCreateUnderParentGraph(buildUser(), graph.id))).resolves.toBeUndefined();
    });

    test("allows team members to view team graphs without managing files", async () => {
        const graph = buildTeamGraph();
        queueTeamGraphAccess(graph, organizationMemberMembership, teamMemberRole);

        await expect(Effect.runPromise(assertCanViewGraph(buildUser(), graph.id))).resolves.toEqual(graph);

        queueTeamGraphAccess(graph, organizationMemberMembership, teamMemberRole);
        await expect(Effect.runPromise(assertCanManageGraphFiles(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("treats system admins as organization admins for existing organizations", async () => {
        const graph = buildTeamGraph();
        queueDbResults([graph], [graph], [team], [], [organization]);

        await expect(Effect.runPromise(assertCanPatchGraph(buildUser({ isSystemAdmin: true, role: "admin" }), graph.id))).resolves.toEqual(
            graph
        );
    });

    test("treats system admins as organization admins over manual member rows", async () => {
        const graph = buildTeamGraph({ teamId: null });
        queueDbResults([graph], [graph], [organizationMemberMembership]);

        await expect(Effect.runPromise(assertCanPatchGraph(buildUser({ isSystemAdmin: true, role: "admin" }), graph.id))).resolves.toEqual(
            graph
        );
    });

    test("rejects file management and mutation for personal graphs", async () => {
        const graph = buildTeamGraph({ organizationId: null, teamId: null, userId: "user-1" });
        queueDbResults([graph], [graph]);

        await expect(Effect.runPromise(assertCanPatchGraph(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);

        queueDbResults([graph], [graph]);
        await expect(Effect.runPromise(assertCanManageGraphFiles(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("allows personal graph owners to manage graph prompts", async () => {
        const graph = buildTeamGraph({ organizationId: null, teamId: null, userId: "user-1" });
        queueDbResults([graph], [graph]);

        await expect(Effect.runPromise(assertCanManageGraphPrompts(buildUser(), graph.id))).resolves.toEqual(graph);
    });

    test("rejects graph prompt management for other users' personal graphs", async () => {
        const graph = buildTeamGraph({ organizationId: null, teamId: null, userId: "user-2" });
        queueDbResults([graph], [graph]);

        await expect(Effect.runPromise(assertCanManageGraphPrompts(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("allows organization admins to manage user prompts outside their active organization", async () => {
        queueDbResults([{ userId: "user-1" }]);

        await expect(
            Effect.runPromise(assertCanManageUserPrompts(buildUser({ activeOrganizationId: "org-1" }), "user-2"))
        ).resolves.toBeUndefined();
    });

    test("rejects user prompt management for users outside administered organizations", async () => {
        queueDbResults([]);

        await expect(Effect.runPromise(assertCanManageUserPrompts(buildUser(), "user-2"))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("allows system admins to manage organization prompts", async () => {
        queueDbResults([organization]);

        await expect(
            Effect.runPromise(assertCanManageOrganizationPrompts(buildUser({ isSystemAdmin: true, role: "admin" }), "org-1"))
        ).resolves.toEqual(organization);
    });

    test("rejects organization prompt management for non-system-admins without touching the database", async () => {
        // No queued DB result: the permission gate must run before the org
        // lookup so non-admins cannot probe organization ID validity.
        await expect(Effect.runPromise(assertCanManageOrganizationPrompts(buildUser(), "org-1"))).rejects.toThrow(
            API_ERROR_CODES.FORBIDDEN
        );
    });

    test("rejects organization prompt management for unknown organizations", async () => {
        queueDbResults([]);

        await expect(
            Effect.runPromise(assertCanManageOrganizationPrompts(buildUser({ isSystemAdmin: true, role: "admin" }), "org-missing"))
        ).rejects.toThrow(API_ERROR_CODES.ORGANIZATION_NOT_FOUND);
    });

    test("allows organization admins to manage organization graphs", async () => {
        const graph = buildTeamGraph({ teamId: null });

        queueDbResults([graph], [graph], [organizationAdminMembership]);

        await expect(Effect.runPromise(assertCanPatchGraph(buildUser(), graph.id))).resolves.toEqual(graph);

        queueDbResults([graph], [graph], [organizationAdminMembership]);
        await expect(Effect.runPromise(assertCanManageGraphFiles(buildUser(), graph.id))).resolves.toEqual(graph);

        queueDbResults([graph], [organizationAdminMembership]);
        await expect(Effect.runPromise(assertCanCreateUnderParentGraph(buildUser(), graph.id))).resolves.toBeUndefined();
    });

    test("allows organization admins to manage suggestions on organization graphs", async () => {
        const graph = buildTeamGraph({ teamId: null });
        queueDbResults([graph], [graph], [organizationAdminMembership]);

        await expect(Effect.runPromise(assertCanManageGraphSuggestions(buildUser(), graph.id))).resolves.toEqual(graph);
    });

    test("rejects organization members managing suggestions on organization graphs", async () => {
        const graph = buildTeamGraph({ teamId: null });
        queueDbResults([graph], [graph], [organizationMemberMembership]);

        await expect(Effect.runPromise(assertCanManageGraphSuggestions(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("allows organization admins to manage suggestions on team graphs", async () => {
        const graph = buildTeamGraph();
        queueTeamGraphAccess(graph, organizationAdminMembership);

        await expect(Effect.runPromise(assertCanManageGraphSuggestions(buildUser(), graph.id))).resolves.toEqual(graph);
    });

    test("allows team admins to manage suggestions on team graphs", async () => {
        const graph = buildTeamGraph();
        queueTeamGraphAccess(graph, organizationMemberMembership, teamAdminRole);

        await expect(Effect.runPromise(assertCanManageGraphSuggestions(buildUser(), graph.id))).resolves.toEqual(graph);
    });

    test("rejects team moderators and members managing suggestions on team graphs", async () => {
        const graph = buildTeamGraph();
        queueTeamGraphAccess(graph, organizationMemberMembership, teamModeratorRole);

        await expect(Effect.runPromise(assertCanManageGraphSuggestions(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);

        queueTeamGraphAccess(graph, organizationMemberMembership, teamMemberRole);
        await expect(Effect.runPromise(assertCanManageGraphSuggestions(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("rejects suggestion management for personal graphs", async () => {
        const graph = buildTeamGraph({ organizationId: null, teamId: null, userId: "user-1" });
        queueDbResults([graph], [graph]);

        await expect(Effect.runPromise(assertCanManageGraphSuggestions(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("limits organization members to viewing organization graphs", async () => {
        const graph = buildTeamGraph({ teamId: null });

        queueDbResults([graph], [graph], [organizationMemberMembership]);
        await expect(Effect.runPromise(assertCanViewGraph(buildUser(), graph.id))).resolves.toEqual(graph);

        queueDbResults([graph], [graph], [organizationMemberMembership]);

        await expect(Effect.runPromise(assertCanPatchGraph(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);

        queueDbResults([graph], [graph], [organizationMemberMembership]);
        await expect(Effect.runPromise(assertCanManageGraphFiles(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);

        queueDbResults([graph], [organizationMemberMembership]);
        await expect(Effect.runPromise(assertCanCreateUnderParentGraph(buildUser(), graph.id))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });

    test("allows top-level graph creation for organization admins", async () => {
        queueDbResults([organizationAdminMembership]);

        await expect(Effect.runPromise(assertCanCreateTopLevelGraph(buildUser()))).resolves.toEqual(organizationAdminMembership);
    });

    test("rejects top-level graph creation for organization members", async () => {
        queueDbResults([organizationMemberMembership]);

        await expect(Effect.runPromise(assertCanCreateTopLevelGraph(buildUser()))).rejects.toThrow(API_ERROR_CODES.FORBIDDEN);
    });
});
