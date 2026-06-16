import { PgClient } from "@effect/sql-pg";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { types } from "pg";

const DRIZZLE_RAW_TYPE_IDS = [1184, 1114, 1082, 1186, 1231, 1115, 1185, 1187, 1182] as const;

export const PgClientLive = PgClient.layer({
    url: Redacted.make(process.env.DATABASE_URL!),
    types: {
        getTypeParser: (typeId, format) => {
            if (DRIZZLE_RAW_TYPE_IDS.includes(typeId as (typeof DRIZZLE_RAW_TYPE_IDS)[number])) {
                return (value: string) => value;
            }
            return types.getTypeParser(typeId, format);
        },
    },
});

const dbEffect = PgDrizzle.makeWithDefaults();

export type EffectDatabase = Effect.Success<typeof dbEffect>;

export class Database extends Context.Service<Database, EffectDatabase>()("@kiwi/db/Database") {}

export const DatabaseLive = Layer.effect(Database, dbEffect);
export const DatabaseLayer = Layer.provide(DatabaseLive, PgClientLive);
