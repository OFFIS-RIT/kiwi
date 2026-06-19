import { PgClient } from "@effect/sql-pg";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { types } from "pg";

const DRIZZLE_RAW_TYPE_IDS = [1184, 1114, 1082, 1186, 1231, 1115, 1185, 1187, 1182] as const;
const getTypeParser: typeof types.getTypeParser = (
    typeId: Parameters<typeof types.getTypeParser>[0],
    format: Parameters<typeof types.getTypeParser>[1]
) => {
    if (DRIZZLE_RAW_TYPE_IDS.includes(typeId as (typeof DRIZZLE_RAW_TYPE_IDS)[number])) {
        return (val: string) => val;
    }

    return types.getTypeParser(typeId, format);
};

const pgClientConfig = Config.map(Config.redacted("DATABASE_URL"), (url) => ({
    url,
    types: { getTypeParser },
}));

export const PgClientLive = PgClient.layerConfig(pgClientConfig);

const dbEffect = PgDrizzle.makeWithDefaults();

export type EffectDatabase = Effect.Success<typeof dbEffect>;
export class Database extends Context.Service<Database, EffectDatabase>()("@kiwi/db/Database") {}

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
    cause: Schema.Unknown,
}) {
    override get message(): string {
        return "Database operation failed";
    }
}

export type DatabaseTransaction = Parameters<Parameters<EffectDatabase["transaction"]>[0]>[0];

type DatabaseEffectResult<T, E> = Effect.Effect<T, E, never>;

export function tryDb<T, E>(
    thunk: (db: EffectDatabase) => DatabaseEffectResult<T, E>
): Effect.Effect<T, DatabaseError, Database>;
export function tryDb<T>(thunk: (db: EffectDatabase) => PromiseLike<T>): Effect.Effect<T, DatabaseError, Database>;
export function tryDb<T, E>(
    thunk: (db: EffectDatabase) => DatabaseEffectResult<T, E> | PromiseLike<T>
): Effect.Effect<T, DatabaseError, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const result = thunk(db);
        if (Effect.isEffect(result)) {
            return yield* Effect.mapError(result, (cause) => new DatabaseError({ cause }));
        }

        return yield* Effect.tryPromise({
            try: () => result,
            catch: (cause) => new DatabaseError({ cause }),
        });
    });
}

export function tryDbVoid<E>(
    thunk: (db: EffectDatabase) => DatabaseEffectResult<unknown, E>
): Effect.Effect<void, DatabaseError, Database>;
export function tryDbVoid(
    thunk: (db: EffectDatabase) => PromiseLike<unknown>
): Effect.Effect<void, DatabaseError, Database>;
export function tryDbVoid<E>(
    thunk: (db: EffectDatabase) => DatabaseEffectResult<unknown, E> | PromiseLike<unknown>
): Effect.Effect<void, DatabaseError, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const result = thunk(db);
        if (Effect.isEffect(result)) {
            return yield* Effect.asVoid(Effect.mapError(result, (cause) => new DatabaseError({ cause })));
        }

        return yield* Effect.asVoid(
            Effect.tryPromise({
                try: () => result,
                catch: (cause) => new DatabaseError({ cause }),
            })
        );
    });
}

export const DatabaseLive = Layer.effect(Database, dbEffect);
export const DatabaseLayer = Layer.provide(DatabaseLive, PgClientLive);

export function runDatabaseEffect<T, E>(effect: Effect.Effect<T, E, Database>): Promise<T> {
    return Effect.runPromise(Effect.provide(effect, DatabaseLayer));
}
