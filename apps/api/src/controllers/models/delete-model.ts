import { lockModelOrganization, normalizeModelId } from "@kiwi/ai/models";
import { db } from "@kiwi/db";
import { modelsTable } from "@kiwi/db/tables/models";
import { modelNotFoundError } from "@kiwi/contracts/errors";
import { and, asc, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";

export function deleteModel(input: { user: AuthUser; modelId: string }) {
    return tryApiPromise(async () => {
        const membership = await Effect.runPromise(requireOrganizationAdmin(input.user));
        const organizationId = membership.organizationId;

        await db.transaction(async (tx) => {
            await Effect.runPromise(lockModelOrganization(tx, organizationId));
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

            await tx.delete(modelsTable).where(eq(modelsTable.id, currentModel.id));

            if (!currentModel.isDefault) {
                return;
            }

            const [replacement] = await tx
                .select({ id: modelsTable.id })
                .from(modelsTable)
                .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, currentModel.type)))
                .orderBy(asc(modelsTable.createdAt), asc(modelsTable.id))
                .limit(1);

            if (replacement) {
                await tx.update(modelsTable).set({ isDefault: true }).where(eq(modelsTable.id, replacement.id));
            }
        });
    });
}
