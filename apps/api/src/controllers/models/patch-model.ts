import {
    decryptModelCredentials,
    encryptModelCredentials,
    lockModelOrganization,
    toAdminModelRecord,
    type ModelCredentials,
} from "@kiwi/ai/models";
import { db } from "@kiwi/db";
import { modelsTable } from "@kiwi/db/tables/models";
import { modelNotFoundError } from "@kiwi/contracts/errors";
import type { AiModelAdapter, ModelPatchInput } from "@kiwi/contracts/models";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { env } from "../../env";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";
import { assertCreateModelInput, getModelForUpdate, mergeCredentials } from "./model-credentials";

export function patchModel(input: { user: AuthUser; modelId: string; body: ModelPatchInput }) {
    return tryApiPromise(async () => {
        const membership = await Effect.runPromise(requireOrganizationAdmin(input.user));
        const organizationId = membership.organizationId;

        return db.transaction(async (tx) => {
            await Effect.runPromise(lockModelOrganization(tx, organizationId));
            const currentModel = await Effect.runPromise(getModelForUpdate(tx, organizationId, input.modelId));
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

                assertCreateModelInput({
                    type: currentModel.type,
                    adapter: nextAdapter,
                    providerModel: nextProviderModel,
                    credentials,
                });

                if (input.body.credentials) {
                    modelUpdates.encryptedCredentials = encryptModelCredentials(credentials, env.AUTH_SECRET);
                }
            }

            if (Object.keys(modelUpdates).length === 0) {
                return toAdminModelRecord(currentModel, env.AUTH_SECRET);
            }

            const [model] = await tx
                .update(modelsTable)
                .set(modelUpdates)
                .where(eq(modelsTable.id, currentModel.id))
                .returning();

            if (!model) {
                throw modelNotFoundError();
            }

            return toAdminModelRecord(model, env.AUTH_SECRET);
        });
    });
}
