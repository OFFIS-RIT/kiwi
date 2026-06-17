import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

type Row = Record<string, unknown>;

class TestDatabaseError extends Error {
    constructor({ cause }: { cause: unknown }) {
        super("Database test error", { cause });
        this.name = "DatabaseError";
    }
}

const selectResults: Row[][] = [];

function nextSelectResult() {
    const result = selectResults.shift();
    if (!result) {
        throw new Error("Unexpected select query");
    }

    return result;
}

function queryEffect() {
    const effect = Effect.sync(nextSelectResult);
    return {
        pipe: effect.pipe.bind(effect),
        limit: () => effect,
        orderBy: () => ({
            limit: () => effect,
        }),
    };
}

type TestDatabase = {
    select: () => {
        from: () => {
            where: () => ReturnType<typeof queryEffect>;
        };
    };
};

const Database = Context.Service<TestDatabase>("@kiwi/db/Database");
const testDatabase = {
    select: () => ({
        from: () => ({
            where: () => queryEffect(),
        }),
    }),
} satisfies TestDatabase;

mock.module("@kiwi/db/effect", () => ({
    Database,
    DatabaseError: TestDatabaseError,
    runDatabaseEffect: <T, E>(effect: Effect.Effect<T, E, TestDatabase>) =>
        Effect.runPromise(Effect.provideService(effect, Database, testDatabase)),
}));

mock.module("@kiwi/logger", () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
}));

const { getNeighboursTool, getPathBetweenTool } = await import("../tools/relationship");

async function executeTool(tool: { execute?: (input: unknown) => Promise<string> }, input: unknown) {
    if (!tool.execute) {
        throw new Error("Tool has no execute function");
    }

    return tool.execute(input);
}

describe("relationship graph tools", () => {
    beforeEach(() => {
        selectResults.length = 0;
    });

    test("get_path_between_entities does not traverse directed relationships backwards", async () => {
        selectResults.push([{ id: "relationship-ba", sourceId: "entity-b", targetId: "entity-a", directed: true }]);

        const output = await executeTool(getPathBetweenTool("graph-1"), {
            sourceEntityId: "entity-a",
            targetEntityId: "entity-b",
        });

        expect(output).toContain("none found");
    });

    test("get_path_between_entities returns no path for missing same-entity requests", async () => {
        selectResults.push([]);

        const output = await executeTool(getPathBetweenTool("graph-1"), {
            sourceEntityId: "missing-entity",
            targetEntityId: "missing-entity",
        });

        expect(output).toBe("## Path\n- none found within 5 hops");
        expect(output).not.toContain("- missing-entity,");
    });

    test("get_path_between_entities returns zero-hop path for existing same-entity requests", async () => {
        selectResults.push([{ id: "entity-a", name: "A", type: "CODE_FUNCTION" }]);

        const output = await executeTool(getPathBetweenTool("graph-1"), {
            sourceEntityId: "entity-a",
            targetEntityId: "entity-a",
        });

        expect(output).toBe("## Path\n- entity-a, A, CODE_FUNCTION");
    });

    test("get_path_between_entities traverses directed relationships forward", async () => {
        selectResults.push(
            [{ id: "relationship-ab", sourceId: "entity-a", targetId: "entity-b", directed: true }],
            [{ id: "relationship-bc", sourceId: "entity-b", targetId: "entity-c", directed: true }],
            [
                { id: "entity-a", name: "A", type: "CODE_FUNCTION" },
                { id: "entity-b", name: "B", type: "CODE_FUNCTION" },
                { id: "entity-c", name: "C", type: "CODE_FUNCTION" },
            ],
            [
                {
                    id: "relationship-ab",
                    sourceId: "entity-a",
                    targetId: "entity-b",
                    kind: "CALLS",
                    directed: true,
                    description: "A calls B.",
                },
                {
                    id: "relationship-bc",
                    sourceId: "entity-b",
                    targetId: "entity-c",
                    kind: "CALLS",
                    directed: true,
                    description: "B calls C.",
                },
            ]
        );

        const output = await executeTool(getPathBetweenTool("graph-1"), {
            sourceEntityId: "entity-a",
            targetEntityId: "entity-c",
        });

        expect(output).toContain("relationship-ab, entity-a -> entity-b, CALLS");
        expect(output).toContain("relationship-bc, entity-b -> entity-c, CALLS");
    });

    test("get_path_between_entities still traverses undirected relationships both ways", async () => {
        selectResults.push(
            [{ id: "relationship-ba", sourceId: "entity-b", targetId: "entity-a", directed: false }],
            [
                { id: "entity-a", name: "A", type: "CODE_FUNCTION" },
                { id: "entity-b", name: "B", type: "CODE_FUNCTION" },
            ],
            [
                {
                    id: "relationship-ba",
                    sourceId: "entity-b",
                    targetId: "entity-a",
                    kind: "RELATED",
                    directed: false,
                    description: "A and B are related.",
                },
            ]
        );

        const output = await executeTool(getPathBetweenTool("graph-1"), {
            sourceEntityId: "entity-a",
            targetEntityId: "entity-b",
        });

        expect(output).toContain("relationship-ba, entity-b -- entity-a, RELATED");
    });

    test("get_entity_neighbours reports relationship kind and direction", async () => {
        selectResults.push(
            [
                {
                    id: "relationship-ab",
                    sourceId: "entity-a",
                    targetId: "entity-b",
                    kind: "CALLS",
                    directed: true,
                    description: "A calls B.",
                    rank: 0.8,
                },
            ],
            [{ id: "entity-b", name: "B", type: "CODE_FUNCTION", description: "Function B." }]
        );

        const output = await executeTool(getNeighboursTool("graph-1"), {
            entityId: "entity-a",
            limit: 10,
        });

        expect(output).toContain("relationship-ab, CALLS, outgoing, entity-a -> entity-b");
    });
});
