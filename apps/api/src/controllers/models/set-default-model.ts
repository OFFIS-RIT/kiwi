import * as Effect from "effect/Effect";
import { normalizeModelId, toAdminModelRecord } from "@kiwi/ai/models";
import { tryDb } from "@kiwi/db/effect";
import { modelsTable } from "@kiwi/db/tables/models";
import { modelNotFoundError } from "@kiwi/contracts/errors";
import { and, eq } from "drizzle-orm";
import { env } from "../../env";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError } from "../_shared/api-effect";

export function setDefaultModel(input: { user: AuthUser; modelId: string }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const membership = yield* requireOrganizationAdmin(input.user);
            const organizationId = membership.organizationId;

            return yield* tryDb((db) =>
                db.transaction((tx) =>
                    Effect.gen(function* () {
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

                        yield* tx
                            .update(modelsTable)
                            .set({ isDefault: false })
                            .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, currentModel.type)));

                        const [model] = yield* tx
                            .update(modelsTable)
                            .set({ isDefault: true })
                            .where(eq(modelsTable.id, currentModel.id))
                            .returning();

                        return toAdminModelRecord(model ?? currentModel, env.AUTH_SECRET);
                    })
                )
            );
        }),
        toApiError
    );
}
