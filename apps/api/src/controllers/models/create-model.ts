import { encryptModelCredentials, normalizeModelId, toAdminModelRecord } from "@kiwi/ai/models";
import { tryDb } from "@kiwi/db/effect";
import { organizationTable } from "@kiwi/db/tables/auth";
import { modelsTable } from "@kiwi/db/tables/models";
import { internalServerError, modelNotConfiguredError } from "@kiwi/contracts/errors";
import type { ModelCreateInput } from "@kiwi/contracts/models";
import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { env } from "../../env";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError, tryApiSync } from "../_shared/api-effect";
import { assertCreateModelInput, normalizeCredentials } from "./model-credentials";

export function createModel(input: { user: AuthUser; body: ModelCreateInput }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const membership = yield* requireOrganizationAdmin(input.user);
            const organizationId = membership.organizationId;
            const credentials = normalizeCredentials(input.body.credentials);
            const providerModel = input.body.provider_model.trim();

            yield* tryApiSync(() =>
                assertCreateModelInput({
                    type: input.body.type,
                    adapter: input.body.adapter,
                    providerModel,
                    credentials,
                })
            );

            return yield* tryDb((db) =>
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

                        const baseModelId = normalizeModelId(input.body.model_id);
                        let modelId = baseModelId;
                        let suffix = 1;
                        while (true) {
                            const [existingModel] = yield* tx
                                .select({ id: modelsTable.id })
                                .from(modelsTable)
                                .where(
                                    and(
                                        eq(modelsTable.organizationId, organizationId),
                                        eq(modelsTable.modelId, modelId)
                                    )
                                )
                                .limit(1);

                            if (!existingModel) {
                                break;
                            }

                            modelId = `${baseModelId}-${suffix}`;
                            suffix += 1;
                        }

                        const [existingTypeModel] = yield* tx
                            .select({ id: modelsTable.id })
                            .from(modelsTable)
                            .where(
                                and(
                                    eq(modelsTable.organizationId, organizationId),
                                    eq(modelsTable.type, input.body.type)
                                )
                            )
                            .limit(1);
                        const isDefault = input.body.is_default === true || !existingTypeModel;

                        if (isDefault) {
                            yield* tx
                                .update(modelsTable)
                                .set({ isDefault: false })
                                .where(
                                    and(
                                        eq(modelsTable.organizationId, organizationId),
                                        eq(modelsTable.type, input.body.type)
                                    )
                                );
                        }

                        const [model] = yield* tx
                            .insert(modelsTable)
                            .values({
                                organizationId,
                                modelId,
                                displayName: input.body.display_name.trim(),
                                type: input.body.type,
                                adapter: input.body.adapter,
                                providerModel,
                                ...(input.body.context_window !== undefined
                                    ? { contextWindow: input.body.context_window }
                                    : {}),
                                encryptedCredentials: encryptModelCredentials(credentials, env.AUTH_SECRET),
                                isDefault,
                            })
                            .returning();

                        if (!model) {
                            return yield* Effect.fail(internalServerError());
                        }

                        return toAdminModelRecord(model, env.AUTH_SECRET);
                    })
                )
            );
        }),
        toApiError
    );
}
