import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import { asc } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import { toPublicConnector } from "../../lib/connectors";
import { connectorApiErrorOptions, toApiError } from "../_shared/api-effect"

export function listConnectors(input: { user: AuthUser }) {
    return Effect.mapError(Effect.map(
        Effect.tryPromise(() => db.select().from(connectorsTable).orderBy(asc(connectorsTable.name))),
        (rows) => rows.filter((row) => input.user.isSystemAdmin || row.status === "active").map(toPublicConnector)
    ), (error) => toApiError(error, connectorApiErrorOptions));
}
