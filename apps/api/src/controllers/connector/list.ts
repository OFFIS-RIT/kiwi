import * as Effect from "effect/Effect";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import { asc } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import { toPublicConnector } from "../../lib/connectors";
import { connectorApiErrorOptions, toApiError } from "../_shared/api-effect"

export function listConnectors(input: { user: AuthUser }): Effect.Effect<ReturnType<typeof toPublicConnector>[], ReturnType<typeof toApiError>, Database> {
    return Effect.mapError(Effect.map(
        tryDb((db) => db.select().from(connectorsTable).orderBy(asc(connectorsTable.name))),
        (rows) => rows.filter((row) => input.user.isSystemAdmin || row.status === "active").map(toPublicConnector)
    ), (error) => toApiError(error, connectorApiErrorOptions));
}
