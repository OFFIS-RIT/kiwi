import { db } from "@kiwi/db";
import { connectorsTable } from "@kiwi/db/tables/connectors";
import { asc } from "drizzle-orm";
import type { AuthUser } from "../../middleware/auth";
import { toPublicConnector } from "../../lib/connectors";
import { tryApiPromise } from "../_shared/api-effect";

export function listConnectors(input: { user: AuthUser }) {
    return tryApiPromise(async () => {
        const rows = await db.select().from(connectorsTable).orderBy(asc(connectorsTable.name));
        return rows.filter((row) => input.user.isSystemAdmin || row.status === "active").map(toPublicConnector);
    });
}
