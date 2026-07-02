import { describe, expect, mock, test } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
    provideWorkerDb as provideWorkerDbType,
    runWorkerEffect as runWorkerEffectType,
} from "../effect";

type TestDatabase = {
    readonly label: string;
};

class MockDatabase extends Context.Service<MockDatabase, TestDatabase>()("@kiwi/db/Database") {}

mock.module("@kiwi/ai", () => ({
    AiClientFactory: {},
    AiClientFactoryLive: Layer.empty,
}));

mock.module("@kiwi/ai/models", () => ({
    AiModelRegistry: {},
    makeAiModelRegistryLayer: () => Layer.empty,
}));

mock.module("@kiwi/db/effect", () => ({
    Database: MockDatabase,
    DatabaseError: class DatabaseError extends Error {
        override readonly cause: unknown;

        constructor(options: { readonly cause: unknown }) {
            super("DatabaseError");
            this.cause = options.cause;
        }
    },
    DatabaseLayer: Layer.empty,
}));

mock.module("@kiwi/files", () => ({
    FileStorage: {},
    FileStorageLive: Layer.empty,
}));

mock.module("@kiwi/logger", () => ({
    LoggerService: {},
    LoggerLive: Layer.empty,
}));

mock.module("../../../env", () => ({
    env: { AUTH_SECRET: "test-auth-secret" },
}));

// Dynamic import is required so module mocks replace WorkerLayer dependencies before ../effect is evaluated.
const {
    provideWorkerDb,
    runWorkerEffect,
}: {
    readonly provideWorkerDb: typeof provideWorkerDbType;
    readonly runWorkerEffect: typeof runWorkerEffectType;
} = await import("../effect");

class TaggedTestError extends Schema.TaggedErrorClass<TaggedTestError>()("TaggedTestError", {
    capability: Schema.String,
    operation: Schema.String,
    code: Schema.String,
    message: Schema.String,
}) {}

describe("runWorkerEffect", () => {
    test("rejects tagged Error failures with the original typed error and fields", async () => {
        const failure = new TaggedTestError({
            capability: "text",
            operation: "generate-description",
            code: "MODEL_NOT_CONFIGURED",
            message: "worker model is not configured",
        });

        const rejected = await runWorkerEffect(Effect.fail(failure)).then(
            () => {
                throw new Error("Expected runWorkerEffect to reject");
            },
            (error) => error
        );

        expect(rejected).toBe(failure);
        expect(rejected).toBeInstanceOf(TaggedTestError);
        expect(rejected).toMatchObject({
            _tag: "TaggedTestError",
            capability: "text",
            operation: "generate-description",
            code: "MODEL_NOT_CONFIGURED",
            message: "worker model is not configured",
        });
    });
});

describe("provideWorkerDb", () => {
    test("preserves tagged domain failures from work that has obtained the database", async () => {
        const testDatabase: TestDatabase = { label: "worker-db" };
        const failure = new TaggedTestError({
            capability: "embedding",
            operation: "sync-connector-resource-graph",
            code: "RESOURCE_NOT_READY",
            message: "resource graph is not ready",
        });

        const rejected = await Effect.runPromise(
            Effect.flip(
                Effect.provideService(
                    provideWorkerDb((db) =>
                        (db as unknown) === testDatabase
                            ? Effect.fail(failure)
                            : Effect.die("provideWorkerDb used an unexpected database")
                    ) as Effect.Effect<never, TaggedTestError, MockDatabase>,
                    MockDatabase,
                    testDatabase
                )
            )
        );

        expect(rejected).toBe(failure);
        expect(rejected).toBeInstanceOf(TaggedTestError);
        expect(rejected).toMatchObject({
            _tag: "TaggedTestError",
            capability: "embedding",
            operation: "sync-connector-resource-graph",
            code: "RESOURCE_NOT_READY",
            message: "resource graph is not ready",
        });
    });
});
