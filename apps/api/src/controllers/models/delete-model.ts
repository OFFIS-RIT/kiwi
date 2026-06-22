import { normalizeModelId } from "@kiwi/ai/models";
import { tryDbVoid } from "@kiwi/db/effect";
import { organizationTable } from "@kiwi/db/tables/auth";
import { modelsTable } from "@kiwi/db/tables/models";
import { modelNotConfiguredError, modelNotFoundError } from "@kiwi/contracts/errors";
import { and, asc, eq } from "@kiwi/db/drizzle";
import * as Effect from "effect/Effect";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError } from "../_shared/api-effect";

export function deleteModel(input: { user: AuthUser; modelId: string }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const membership = yield* requireOrganizationAdmin(input.user);
            const organizationId = membership.organizationId;

            yield* tryDbVoid((db) =>
                db.transaction((tx) =>
                    Effect.gen(function* () {
                        const [organization] = yield* tx
                            .select({ id: organizationTable.id })
                            .from(organizationTable)
                            .where(eq(organizationTable.id, organizationId))
                            .limit(1)
                            .for("update");

                        if (!organization) {
                            return yield* Effect.fail(modelNotConfiguredError());
                        }

                        const [currentModel] = yield* tx
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
                            return yield* Effect.fail(modelNotFoundError());
                        }

                        yield* tx.delete(modelsTable).where(eq(modelsTable.id, currentModel.id));

                        if (!currentModel.isDefault) {
                            return;
                        }

                        const [replacement] = yield* tx
                            .select({ id: modelsTable.id })
                            .from(modelsTable)
                            .where(
                                and(
                                    eq(modelsTable.organizationId, organizationId),
                                    eq(modelsTable.type, currentModel.type)
                                )
                            )
                            .orderBy(asc(modelsTable.createdAt), asc(modelsTable.id))
                            .limit(1);

                        if (replacement) {
                            yield* tx
                                .update(modelsTable)
                                .set({ isDefault: true })
                                .where(eq(modelsTable.id, replacement.id));
                        }
                    })
                )
            );
        }),
        toApiError
    );
}
