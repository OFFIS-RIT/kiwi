import { Database, DatabaseError, DatabaseLayer, type EffectDatabase } from "@kiwi/db/effect";
import * as Effect from "effect/Effect";

export function useWorkerDb<T, E, R>(
    work: (db: EffectDatabase) => Effect.Effect<T, E, R>
): Effect.Effect<T, E | DatabaseError, R | Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        return yield* Effect.mapError(work(db), (cause) => new DatabaseError({ cause }));
    });
}

export function useWorkerDbVoid<E, R>(
    work: (db: EffectDatabase) => Effect.Effect<unknown, E, R>
): Effect.Effect<void, E | DatabaseError, R | Database> {
    return Effect.asVoid(useWorkerDb(work));
}

export function runWorkerEffect<T, E, R>(effect: Effect.Effect<T, E, R>): Promise<T> {
    return Effect.runPromise(Effect.provide(effect as Effect.Effect<T, E, never>, DatabaseLayer));
}
