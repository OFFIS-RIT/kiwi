import * as Effect from "effect/Effect";
import { normalizeModelId, toAdminModelRecord } from "@kiwi/ai/models";
import { db } from "@kiwi/db";
import { modelsTable } from "@kiwi/db/tables/models";
import { modelNotFoundError } from "@kiwi/contracts/errors";
import { and, eq } from "drizzle-orm";
import { env } from "../../env";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";

export function setDefaultModel(input: { user: AuthUser; modelId: string }) {
    return tryApiPromise(async () => {
        const membership = await Effect.runPromise(requireOrganizationAdmin(input.user));
        const organizationId = membership.organizationId;

        return db.transaction(async (tx) => {
            const [currentModel] = await tx
                .select()
                .from(modelsTable)
                .where(
                    and(
                        eq(modelsTable.organizationId, organizationId),
                        eq(modelsTable.modelId, normalizeModelId(input.modelId))
                    )
                )
                .limit(1)
                .for("update");

            if (!currentModel) {
                throw modelNotFoundError();
            }

            await tx
                .update(modelsTable)
                .set({ isDefault: false })
                .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, currentModel.type)));

            const [model] = await tx
                .update(modelsTable)
                .set({ isDefault: true })
                .where(eq(modelsTable.id, currentModel.id))
                .returning();

            return toAdminModelRecord(model ?? currentModel, env.AUTH_SECRET);
        });
    });
}
