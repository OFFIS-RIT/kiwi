import {
    decryptModelCredentials,
    encryptModelCredentials,
    normalizeModelId,
    toAdminModelRecord,
    type ModelCredentials,
} from "@kiwi/ai/models";
import { tryDb } from "@kiwi/db/effect";
import { organizationTable } from "@kiwi/db/tables/auth";
import { modelsTable } from "@kiwi/db/tables/models";
import { modelNotConfiguredError, modelNotFoundError } from "@kiwi/contracts/errors";
import type { AiModelAdapter, ModelPatchInput } from "@kiwi/contracts/models";
import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { env } from "../../env";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError, tryApiSync } from "../_shared/api-effect";
import { assertCreateModelInput, mergeCredentials } from "./model-credentials";

export function patchModel(input: { user: AuthUser; modelId: string; body: ModelPatchInput }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const membership = yield* requireOrganizationAdmin(input.user);
            const organizationId = membership.organizationId;

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

                        const [currentModel] = yield* tx
                            .select()
                            .from(modelsTable)
                            .where(
                                and(
                                    eq(modelsTable.organizationId, organizationId),
                                    eq(modelsTable.modelId, normalizeModelId(input.modelId))
                                )
                            )
                            .limit(1);

                        if (!currentModel) {
                            return yield* Effect.fail(modelNotFoundError());
                        }

                        const nextAdapter = input.body.adapter ?? currentModel.adapter;
                        const nextProviderModel = input.body.provider_model?.trim() ?? currentModel.providerModel;
                        const shouldValidateModel =
                            input.body.adapter !== undefined ||
                            input.body.provider_model !== undefined ||
                            input.body.credentials !== undefined;
                        const modelUpdates: {
                            displayName?: string;
                            adapter?: AiModelAdapter;
                            providerModel?: string;
                            contextWindow?: number;
                            encryptedCredentials?: string;
                        } = {};

                        if (input.body.display_name !== undefined) {
                            modelUpdates.displayName = input.body.display_name.trim();
                        }

                        if (input.body.context_window !== undefined) {
                            modelUpdates.contextWindow = input.body.context_window;
                        }

                        if (input.body.adapter !== undefined) {
                            modelUpdates.adapter = nextAdapter;
                        }

                        if (input.body.provider_model !== undefined) {
                            modelUpdates.providerModel = nextProviderModel;
                        }

                        if (shouldValidateModel) {
                            const stored = decryptModelCredentials(currentModel.encryptedCredentials, env.AUTH_SECRET);
                            const credentials: ModelCredentials = input.body.credentials
                                ? mergeCredentials(stored, input.body.credentials)
                                : stored;

                            yield* tryApiSync(() =>
                                assertCreateModelInput({
                                    type: currentModel.type,
                                    adapter: nextAdapter,
                                    providerModel: nextProviderModel,
                                    credentials,
                                })
                            );

                            if (input.body.credentials) {
                                modelUpdates.encryptedCredentials = encryptModelCredentials(credentials, env.AUTH_SECRET);
                            }
                        }

                        if (Object.keys(modelUpdates).length === 0) {
                            return toAdminModelRecord(currentModel, env.AUTH_SECRET);
                        }

                        const [model] = yield* tx
                            .update(modelsTable)
                            .set(modelUpdates)
                            .where(eq(modelsTable.id, currentModel.id))
                            .returning();

                        if (!model) {
                            return yield* Effect.fail(modelNotFoundError());
                        }

                        return toAdminModelRecord(model, env.AUTH_SECRET);
                    })
                )
            );
        }),
        toApiError
    );
}
