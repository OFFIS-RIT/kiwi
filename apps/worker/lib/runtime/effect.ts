import { AiClientFactory, AiClientFactoryLive } from "@kiwi/ai";
import { AiModelRegistry, makeAiModelRegistryLayer } from "@kiwi/ai/models";
import { Database, DatabaseError, DatabaseLayer, type EffectDatabase } from "@kiwi/db/effect";
import { FileStorage, FileStorageLive } from "@kiwi/files";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { env } from "../../env";

const AiModelRegistryLayer = makeAiModelRegistryLayer(env.AUTH_SECRET).pipe(Layer.provideMerge(DatabaseLayer));
const WorkerLayer = Layer.mergeAll(AiModelRegistryLayer, FileStorageLive, AiClientFactoryLive);

export type WorkerServices = Database | FileStorage | AiModelRegistry | AiClientFactory;
export function withWorkerDb<T, E, R>(
    work: (db: EffectDatabase) => Effect.Effect<T, E, R>
): Effect.Effect<T, E | DatabaseError, R | Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        return yield* Effect.mapError(work(db), (cause) => new DatabaseError({ cause }));
    });
}

export function withWorkerDbVoid<E, R>(
    work: (db: EffectDatabase) => Effect.Effect<unknown, E, R>
): Effect.Effect<void, E | DatabaseError, R | Database> {
    return Effect.asVoid(withWorkerDb(work));
}

export function runWorkerEffect<T, E, R>(effect: Effect.Effect<T, E, R>): Promise<T> {
    return Effect.runPromise(Effect.provide(effect as Effect.Effect<T, E, WorkerServices>, WorkerLayer));
}
