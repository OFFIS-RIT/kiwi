import { describe, expect, test } from "bun:test";
import type { Graph } from "../index.ts";
import { mergeGraphs } from "../merge.ts";

describe("mergeGraphs", () => {
    test("merges matching entities and remaps matching relationships", () => {
        const left: Graph = {
            id: "graph-left",
            units: [
                {
                    id: "unit-1",
                    fileId: "file-1",
                    content: "Alice works at Acme.",
                },
            ],
            entities: [
                {
                    id: "entity-acme-left",
                    name: "ACME",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [
                        {
                            id: "source-acme-left",
                            unitId: "unit-1",
                            description: "Acme is an organization.",
                        },
                    ],
                },
                {
                    id: "entity-alice-left",
                    name: "ALICE",
                    type: "PERSON",
                    description: "",
                    sources: [
                        {
                            id: "source-alice-left",
                            unitId: "unit-1",
                            description: "Alice is a person.",
                        },
                    ],
                },
            ],
            relationships: [
                {
                    id: "relationship-left",
                    sourceId: "entity-alice-left",
                    targetId: "entity-acme-left",
                    strength: 0.7,
                    description: "",
                    sources: [
                        {
                            id: "source-relationship-left",
                            unitId: "unit-1",
                            description: "Alice works at Acme.",
                        },
                    ],
                },
            ],
        };

        const right: Graph = {
            id: "graph-right",
            units: [
                {
                    id: "unit-2",
                    fileId: "file-1",
                    content: "Acme employs Alice.",
                },
            ],
            entities: [
                {
                    id: "entity-acme-right",
                    name: "ACME",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [
                        {
                            id: "source-acme-right",
                            unitId: "unit-2",
                            description: "Acme employs Alice.",
                        },
                    ],
                },
                {
                    id: "entity-alice-right",
                    name: "ALICE",
                    type: "PERSON",
                    description: "",
                    sources: [
                        {
                            id: "source-alice-right",
                            unitId: "unit-2",
                            description: "Alice is employed by Acme.",
                        },
                    ],
                },
            ],
            relationships: [
                {
                    id: "relationship-right",
                    sourceId: "entity-acme-right",
                    targetId: "entity-alice-right",
                    strength: 0.9,
                    description: "",
                    sources: [
                        {
                            id: "source-relationship-right",
                            unitId: "unit-2",
                            description: "Acme employs Alice.",
                        },
                    ],
                },
            ],
        };

        const merged = mergeGraphs(left, right);

        expect(merged.id).toBeString();
        expect(merged.units).toEqual([...left.units, ...right.units]);
        expect(merged.entities).toHaveLength(2);
        expect(merged.relationships).toHaveLength(1);

        const acme = merged.entities.find((entity) => entity.name === "ACME" && entity.type === "ORGANIZATION");
        const alice = merged.entities.find((entity) => entity.name === "ALICE" && entity.type === "PERSON");

        expect(acme).toBeDefined();
        expect(alice).toBeDefined();
        expect(acme?.sources).toHaveLength(2);
        expect(alice?.sources).toHaveLength(2);

        const relationship = merged.relationships[0];

        expect(new Set([relationship?.sourceId, relationship?.targetId])).toEqual(new Set([acme?.id, alice?.id]));
        expect(relationship?.sources).toHaveLength(2);
        expect(relationship?.strength).toBe(0.9);
    });

    test("merges multiple graphs passed as an array", () => {
        const graphA: Graph = {
            id: "graph-a",
            units: [
                {
                    id: "unit-a",
                    fileId: "file-a",
                    content: "Alice founded Acme.",
                },
            ],
            entities: [
                {
                    id: "entity-alice-a",
                    name: "ALICE",
                    type: "PERSON",
                    description: "",
                    sources: [
                        {
                            id: "source-alice-a",
                            unitId: "unit-a",
                            description: "Alice founded Acme.",
                        },
                    ],
                },
                {
                    id: "entity-acme-a",
                    name: "ACME",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [
                        {
                            id: "source-acme-a",
                            unitId: "unit-a",
                            description: "Acme exists.",
                        },
                    ],
                },
            ],
            relationships: [
                {
                    id: "relationship-a",
                    sourceId: "entity-alice-a",
                    targetId: "entity-acme-a",
                    strength: 0.4,
                    description: "",
                    sources: [
                        {
                            id: "source-relationship-a",
                            unitId: "unit-a",
                            description: "Alice founded Acme.",
                        },
                    ],
                },
            ],
        };

        const graphB: Graph = {
            id: "graph-b",
            units: [
                {
                    id: "unit-b",
                    fileId: "file-b",
                    content: "Acme hired Bob.",
                },
            ],
            entities: [
                {
                    id: "entity-acme-b",
                    name: "ACME",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [
                        {
                            id: "source-acme-b",
                            unitId: "unit-b",
                            description: "Acme hired Bob.",
                        },
                    ],
                },
                {
                    id: "entity-bob-b",
                    name: "BOB",
                    type: "PERSON",
                    description: "",
                    sources: [
                        {
                            id: "source-bob-b",
                            unitId: "unit-b",
                            description: "Bob was hired by Acme.",
                        },
                    ],
                },
            ],
            relationships: [
                {
                    id: "relationship-b",
                    sourceId: "entity-acme-b",
                    targetId: "entity-bob-b",
                    strength: 0.6,
                    description: "",
                    sources: [
                        {
                            id: "source-relationship-b",
                            unitId: "unit-b",
                            description: "Acme hired Bob.",
                        },
                    ],
                },
            ],
        };

        const graphC: Graph = {
            id: "graph-c",
            units: [
                {
                    id: "unit-c",
                    fileId: "file-c",
                    content: "Bob partnered with Alice.",
                },
            ],
            entities: [
                {
                    id: "entity-alice-c",
                    name: "ALICE",
                    type: "PERSON",
                    description: "",
                    sources: [
                        {
                            id: "source-alice-c",
                            unitId: "unit-c",
                            description: "Alice partnered with Bob.",
                        },
                    ],
                },
                {
                    id: "entity-bob-c",
                    name: "BOB",
                    type: "PERSON",
                    description: "",
                    sources: [
                        {
                            id: "source-bob-c",
                            unitId: "unit-c",
                            description: "Bob partnered with Alice.",
                        },
                    ],
                },
            ],
            relationships: [
                {
                    id: "relationship-c",
                    sourceId: "entity-bob-c",
                    targetId: "entity-alice-c",
                    strength: 0.8,
                    description: "",
                    sources: [
                        {
                            id: "source-relationship-c",
                            unitId: "unit-c",
                            description: "Bob partnered with Alice.",
                        },
                    ],
                },
            ],
        };

        const merged = mergeGraphs([graphA, graphB, graphC]);

        expect(merged.id).toBeString();
        expect(merged.units).toEqual([...graphA.units, ...graphB.units, ...graphC.units]);
        expect(merged.entities).toHaveLength(3);
        expect(merged.relationships).toHaveLength(3);

        const acme = merged.entities.find((entity) => entity.name === "ACME");
        const alice = merged.entities.find((entity) => entity.name === "ALICE");
        const bob = merged.entities.find((entity) => entity.name === "BOB");

        expect(acme?.sources).toHaveLength(2);
        expect(alice?.sources).toHaveLength(2);
        expect(bob?.sources).toHaveLength(2);

        expect(
            merged.relationships.find(
                (relationship) =>
                    new Set([relationship.sourceId, relationship.targetId]).size === 2 &&
                    new Set([relationship.sourceId, relationship.targetId]).has(acme!.id) &&
                    new Set([relationship.sourceId, relationship.targetId]).has(alice!.id)
            )
        ).toBeDefined();
        expect(
            merged.relationships.find(
                (relationship) =>
                    new Set([relationship.sourceId, relationship.targetId]).size === 2 &&
                    new Set([relationship.sourceId, relationship.targetId]).has(acme!.id) &&
                    new Set([relationship.sourceId, relationship.targetId]).has(bob!.id)
            )
        ).toBeDefined();
        expect(
            merged.relationships.find(
                (relationship) =>
                    new Set([relationship.sourceId, relationship.targetId]).size === 2 &&
                    new Set([relationship.sourceId, relationship.targetId]).has(alice!.id) &&
                    new Set([relationship.sourceId, relationship.targetId]).has(bob!.id)
            )
        ).toBeDefined();
    });

    test("returns an empty graph for an empty array", () => {
        const merged = mergeGraphs([]);

        expect(merged.id).toBeString();
        expect(merged.units).toEqual([]);
        expect(merged.entities).toEqual([]);
        expect(merged.relationships).toEqual([]);
    });
});
