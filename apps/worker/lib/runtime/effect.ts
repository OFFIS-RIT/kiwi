import { AiClientFactory, AiClientFactoryLive } from "@kiwi/ai";
import { AiModelRegistry, makeAiModelRegistryLayer } from "@kiwi/ai/models";
import { Database, DatabaseError, DatabaseLayer, type EffectDatabase } from "@kiwi/db/effect";
import { FileStorage, FileStorageLive } from "@kiwi/files";
import { LoggerLive, LoggerService } from "@kiwi/logger";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { env } from "../../env";

const AiModelRegistryLayer = makeAiModelRegistryLayer(env.AUTH_SECRET).pipe(Layer.provideMerge(DatabaseLayer));
const WorkerLayer = Layer.mergeAll(AiModelRegistryLayer, FileStorageLive, AiClientFactoryLive, LoggerLive);

export type WorkerServices = Database | FileStorage | AiModelRegistry | AiClientFactory | LoggerService;
type WorkerDatabaseEffectResult<T> = Effect.Effect<T, unknown, never>;

export function provideWorkerDb<T, E, R>(
    work: (db: EffectDatabase) => Effect.Effect<T, E, R>
): Effect.Effect<T, E, R | Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        return yield* work(db);
    });
}

export function provideWorkerDbVoid<E, R>(
    work: (db: EffectDatabase) => Effect.Effect<unknown, E, R>
): Effect.Effect<void, E, R | Database> {
    return Effect.asVoid(provideWorkerDb(work));
}

export function withWorkerDb<T>(
    work: (db: EffectDatabase) => WorkerDatabaseEffectResult<T> | PromiseLike<T>
): Effect.Effect<T, DatabaseError, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const result = work(db);
        if (Effect.isEffect(result)) {
            return yield* Effect.mapError(result, (cause) => new DatabaseError({ cause }));
        }

        return yield* Effect.tryPromise({
            try: () => result,
            catch: (cause) => new DatabaseError({ cause }),
        });
    });
}

export function withWorkerDbVoid(
    work: (db: EffectDatabase) => WorkerDatabaseEffectResult<unknown> | PromiseLike<unknown>
): Effect.Effect<void, DatabaseError, Database> {
    return Effect.asVoid(withWorkerDb(work));
}


function toThrowableEffectFailure(failure: unknown): Error {
    if (failure instanceof Error) {
        return failure;
    }

    const message = typeof failure === "string" ? failure : "Effect failed";
    const error = new Error(message, { cause: failure });
    Object.defineProperty(error, "failure", {
        value: failure,
        enumerable: true,
        configurable: true,
    });
    return error;
}
export async function runWorkerEffect<T, E, R>(effect: Effect.Effect<T, E, R>): Promise<T> {
    const exit = await Effect.runPromiseExit(
        Effect.provide(effect as Effect.Effect<T, E, WorkerServices>, WorkerLayer)
    );
    if (exit._tag === "Success") {
        return exit.value;
    }
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    throw failure === undefined ? Cause.squash(exit.cause) : toThrowableEffectFailure(failure);
}
