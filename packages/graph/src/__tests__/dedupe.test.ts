import { describe, expect, test } from "bun:test";
import type { Graph } from "../index.ts";
import { dedupe } from "../dedupe.ts";

const textUnit = (id: string, fileId: string, content: string) => ({
    id,
    fileId,
    content,
    startPage: null,
    endPage: null,
    chunks: [{ id: 1, type: "text" as const, text: content, startPage: null, endPage: null }],
});

describe("dedupe", () => {
    test("merges organization aliases and remaps relationships", () => {
        const graph: Graph = {
            id: "graph-1",
            units: [
                textUnit("unit-1", "file-1", "Apple announced a product."),
                textUnit("unit-2", "file-1", "Apple Inc hired Alice."),
            ],
            entities: [
                {
                    id: "entity-apple-short",
                    name: "APPLE",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [
                        { id: "source-apple-short", unitId: "unit-1", description: "Apple announced a product." },
                    ],
                },
                {
                    id: "entity-apple-long",
                    name: "APPLE INC",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [{ id: "source-apple-long", unitId: "unit-2", description: "Apple Inc hired Alice." }],
                },
                {
                    id: "entity-alice",
                    name: "ALICE",
                    type: "PERSON",
                    description: "",
                    sources: [{ id: "source-alice", unitId: "unit-2", description: "Alice works at Apple." }],
                },
            ],
            relationships: [
                {
                    id: "relationship-1",
                    sourceId: "entity-apple-short",
                    targetId: "entity-alice",
                    strength: 0.5,
                    description: "",
                    sources: [
                        { id: "source-relationship-1", unitId: "unit-1", description: "Apple is linked to Alice." },
                    ],
                },
                {
                    id: "relationship-2",
                    sourceId: "entity-alice",
                    targetId: "entity-apple-long",
                    strength: 0.8,
                    description: "",
                    sources: [
                        { id: "source-relationship-2", unitId: "unit-2", description: "Alice works at Apple Inc." },
                    ],
                },
            ],
        };

        const deduped = dedupe(graph);

        expect(deduped.id).toBeString();
        expect(deduped.units).toEqual(graph.units);
        expect(deduped.entities).toHaveLength(2);
        expect(deduped.relationships).toHaveLength(1);

        const apple = deduped.entities.find((entity) => entity.type === "ORGANIZATION");
        const alice = deduped.entities.find((entity) => entity.type === "PERSON");

        expect(apple?.name).toBe("APPLE INC");
        expect(apple?.sources).toHaveLength(2);
        expect(alice?.sources).toHaveLength(1);

        const relationship = deduped.relationships[0];

        expect(new Set([relationship?.sourceId, relationship?.targetId])).toEqual(new Set([apple?.id, alice?.id]));
        expect(relationship?.sources).toHaveLength(2);
        expect(relationship?.strength).toBe(0.8);
    });

    test("merges acronym variants for organizations", () => {
        const graph: Graph = {
            id: "graph-2",
            units: [textUnit("unit-1", "file-1", "IBM is short for International Business Machines.")],
            entities: [
                {
                    id: "entity-ibm",
                    name: "IBM",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [{ id: "source-ibm", unitId: "unit-1", description: "IBM is a company." }],
                },
                {
                    id: "entity-full",
                    name: "INTERNATIONAL BUSINESS MACHINES",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [
                        {
                            id: "source-full",
                            unitId: "unit-1",
                            description: "International Business Machines is a company.",
                        },
                    ],
                },
            ],
            relationships: [],
        };

        const deduped = dedupe(graph);

        expect(deduped.entities).toHaveLength(1);
        expect(deduped.entities[0]?.name).toBe("INTERNATIONAL BUSINESS MACHINES");
        expect(deduped.entities[0]?.sources).toHaveLength(2);
    });

    test("merges names split by whitespace differences", () => {
        const graph: Graph = {
            id: "graph-split-name",
            units: [
                {
                    id: "unit-1",
                    fileId: "file-1",
                    content: "AlphaBeta and Alpha Beta refer to the same product.",
                    startPage: null,
                    endPage: null,
                },
            ],
            entities: [
                {
                    id: "entity-alphabeta",
                    name: "ALPHABETA",
                    type: "PRODUCT",
                    description: "",
                    sources: [{ id: "source-alphabeta", unitId: "unit-1", description: "AlphaBeta launched." }],
                },
                {
                    id: "entity-alpha-beta",
                    name: "ALPHA BETA",
                    type: "PRODUCT",
                    description: "",
                    sources: [{ id: "source-alpha-beta", unitId: "unit-1", description: "Alpha Beta launched." }],
                },
                {
                    id: "entity-gammadelta",
                    name: "GAMMADELTA",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [{ id: "source-gammadelta", unitId: "unit-1", description: "GammaDelta was mentioned." }],
                },
                {
                    id: "entity-gamma-delta",
                    name: "GAMMA DELTA",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [
                        { id: "source-gamma-delta", unitId: "unit-1", description: "Gamma Delta was mentioned." },
                    ],
                },
            ],
            relationships: [],
        };

        const deduped = dedupe(graph);

        expect(deduped.entities).toHaveLength(2);
        expect(deduped.entities.find((entity) => entity.type === "PRODUCT")?.sources).toHaveLength(2);
        expect(deduped.entities.find((entity) => entity.type === "ORGANIZATION")?.sources).toHaveLength(2);
    });

    test("merges compatible person names", () => {
        const graph: Graph = {
            id: "graph-3",
            units: [textUnit("unit-1", "file-1", "John A. Smith met John Smith.")],
            entities: [
                {
                    id: "entity-john-short",
                    name: "JOHN SMITH",
                    type: "PERSON",
                    description: "",
                    sources: [
                        { id: "source-john-short", unitId: "unit-1", description: "John Smith attended the meeting." },
                    ],
                },
                {
                    id: "entity-john-long",
                    name: "JOHN A SMITH",
                    type: "PERSON",
                    description: "",
                    sources: [
                        { id: "source-john-long", unitId: "unit-1", description: "John A Smith attended the meeting." },
                    ],
                },
            ],
            relationships: [],
        };

        const deduped = dedupe(graph);

        expect(deduped.entities).toHaveLength(1);
        expect(deduped.entities[0]?.name).toBe("JOHN A SMITH");
        expect(deduped.entities[0]?.sources).toHaveLength(2);
    });

    test("does not merge exact-only types unless names match exactly after normalization", () => {
        const graph: Graph = {
            id: "graph-4",
            units: [textUnit("unit-1", "file-1", "Two facts exist.")],
            entities: [
                {
                    id: "entity-fact-a",
                    name: "FACT: APPLE REVENUE",
                    type: "FACT",
                    description: "",
                    sources: [{ id: "source-fact-a", unitId: "unit-1", description: "Apple revenue fact." }],
                },
                {
                    id: "entity-fact-b",
                    name: "FACT: APPLE SALES",
                    type: "FACT",
                    description: "",
                    sources: [{ id: "source-fact-b", unitId: "unit-1", description: "Apple sales fact." }],
                },
                {
                    id: "entity-date-a",
                    name: "2026-03-25",
                    type: "DATE",
                    description: "",
                    sources: [{ id: "source-date-a", unitId: "unit-1", description: "Date A." }],
                },
                {
                    id: "entity-date-b",
                    name: "2026 03 25",
                    type: "DATE",
                    description: "",
                    sources: [{ id: "source-date-b", unitId: "unit-1", description: "Date B." }],
                },
            ],
            relationships: [],
        };

        const deduped = dedupe(graph);

        expect(deduped.entities).toHaveLength(3);
        expect(deduped.entities.filter((entity) => entity.type === "FACT")).toHaveLength(2);
        expect(deduped.entities.filter((entity) => entity.type === "DATE")).toHaveLength(1);
    });

    test("does not merge same name across different types", () => {
        const graph: Graph = {
            id: "graph-5",
            units: [textUnit("unit-1", "file-1", "Apple can be a company or a product.")],
            entities: [
                {
                    id: "entity-org",
                    name: "APPLE",
                    type: "ORGANIZATION",
                    description: "",
                    sources: [{ id: "source-org", unitId: "unit-1", description: "Apple is a company." }],
                },
                {
                    id: "entity-product",
                    name: "APPLE",
                    type: "PRODUCT",
                    description: "",
                    sources: [{ id: "source-product", unitId: "unit-1", description: "Apple is a product." }],
                },
            ],
            relationships: [],
        };

        const deduped = dedupe(graph);

        expect(deduped.entities).toHaveLength(2);
    });

    test("does not merge relationships with different kinds", () => {
        const graph: Graph = {
            id: "graph-relationship-kinds",
            units: [textUnit("unit-1", "file-1", "A imports and calls B.")],
            entities: [
                { id: "entity-a", name: "A", type: "CODE_FUNCTION", description: "", sources: [] },
                { id: "entity-b", name: "B", type: "CODE_FUNCTION", description: "", sources: [] },
            ],
            relationships: [
                {
                    id: "relationship-imports",
                    sourceId: "entity-a",
                    targetId: "entity-b",
                    kind: "IMPORTS",
                    directed: true,
                    strength: 0.9,
                    description: "",
                    sources: [],
                },
                {
                    id: "relationship-calls",
                    sourceId: "entity-a",
                    targetId: "entity-b",
                    kind: "CALLS",
                    directed: true,
                    strength: 0.8,
                    description: "",
                    sources: [],
                },
            ],
        };

        const deduped = dedupe(graph);

        expect(deduped.relationships.map((relationship) => relationship.kind).sort()).toEqual(["CALLS", "IMPORTS"]);
    });
});
