import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { EffectDatabase } from "../effect";
import { Database, DatabaseError, provideDb, provideDbVoid, tryDb } from "../effect";

const testDatabase = {
    label: "fake-db",
} as unknown as EffectDatabase;

class DomainTestError extends Schema.TaggedErrorClass<DomainTestError>()("DomainTestError", {
    operation: Schema.String,
    message: Schema.String,
}) {}

function withTestDatabase<T, E>(effect: Effect.Effect<T, E, Database>): Effect.Effect<T, E, never> {
    return Effect.provideService(effect, Database, testDatabase);
}

function runFailure<T, E>(effect: Effect.Effect<T, E, never>): Promise<E> {
    return Effect.runPromise(Effect.flip(effect));
}

describe("tryDb", () => {
    test("maps rejected Promise database work to DatabaseError with the raw cause", async () => {
        const rawFailure = new Error("connection reset while selecting rows");

        const failure = await runFailure(withTestDatabase(tryDb(() => Promise.reject(rawFailure))));

        expect(failure).toBeInstanceOf(DatabaseError);
        expect(failure).toMatchObject({
            _tag: "@kiwi/db/DatabaseError",
            cause: rawFailure,
            message: "Database operation failed",
        });
    });

    test("maps failed Drizzle Effect work to DatabaseError with the raw cause", async () => {
        const rawFailure = new Error("drizzle execute failed");

        const failure = await runFailure(withTestDatabase(tryDb(() => Effect.fail(rawFailure))));

        expect(failure).toBeInstanceOf(DatabaseError);
        expect(failure).toMatchObject({
            _tag: "@kiwi/db/DatabaseError",
            cause: rawFailure,
            message: "Database operation failed",
        });
    });
});

describe("provideDb", () => {
    test("preserves tagged domain failures from composed database work", async () => {
        const domainFailure = new DomainTestError({
            operation: "validate-graph-state",
            message: "graph is not ready for processing",
        });

        const failure = await runFailure(
            withTestDatabase(
                provideDb((db) =>
                    db === testDatabase
                        ? Effect.fail(domainFailure)
                        : Effect.die("provideDb used an unexpected database")
                )
            )
        );

        expect(failure).toBe(domainFailure);
        expect(failure).toBeInstanceOf(DomainTestError);
        expect(failure).not.toBeInstanceOf(DatabaseError);
        expect(failure).toMatchObject({
            _tag: "DomainTestError",
            operation: "validate-graph-state",
            message: "graph is not ready for processing",
        });
    });

    test("provideDbVoid preserves tagged domain failures instead of relabeling them", async () => {
        const domainFailure = new DomainTestError({
            operation: "cleanup-upload-record",
            message: "upload is still referenced",
        });

        const failure = await runFailure(
            withTestDatabase(
                provideDbVoid((db) =>
                    db === testDatabase
                        ? Effect.fail(domainFailure)
                        : Effect.die("provideDbVoid used an unexpected database")
                )
            )
        );

        expect(failure).toBe(domainFailure);
        expect(failure).toBeInstanceOf(DomainTestError);
        expect(failure).not.toBeInstanceOf(DatabaseError);
        expect(failure).toMatchObject({
            _tag: "DomainTestError",
            operation: "cleanup-upload-record",
            message: "upload is still referenced",
        });
    });
});
