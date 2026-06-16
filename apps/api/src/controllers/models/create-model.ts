import { allocateModelId, encryptModelCredentials, lockModelOrganization, toAdminModelRecord } from "@kiwi/ai/models";
import { db } from "@kiwi/db";
import { modelsTable } from "@kiwi/db/tables/models";
import { internalServerError } from "@kiwi/contracts/errors";
import type { ModelCreateInput } from "@kiwi/contracts/models";
import { and, eq } from "drizzle-orm";
import { env } from "../../env";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";
import { assertCreateModelInput, normalizeCredentials } from "./model-credentials";

export function createModel(input: { user: AuthUser; body: ModelCreateInput }) {
    return tryApiPromise(async () => {
        const membership = await requireOrganizationAdmin(input.user);
        const organizationId = membership.organizationId;
        const credentials = normalizeCredentials(input.body.credentials);
        const providerModel = input.body.provider_model.trim();

        assertCreateModelInput({
            type: input.body.type,
            adapter: input.body.adapter,
            providerModel,
            credentials,
        });

        return db.transaction(async (tx) => {
            await lockModelOrganization(tx, organizationId);
            const modelId = await allocateModelId(tx, organizationId, input.body.model_id);
            const [existingTypeModel] = await tx
                .select({ id: modelsTable.id })
                .from(modelsTable)
                .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, input.body.type)))
                .limit(1);
            const isDefault = input.body.is_default === true || !existingTypeModel;

            if (isDefault) {
                await tx
                    .update(modelsTable)
                    .set({ isDefault: false })
                    .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, input.body.type)));
            }

            const [model] = await tx
                .insert(modelsTable)
                .values({
                    organizationId,
                    modelId,
                    displayName: input.body.display_name.trim(),
                    type: input.body.type,
                    adapter: input.body.adapter,
                    providerModel,
                    ...(input.body.context_window !== undefined ? { contextWindow: input.body.context_window } : {}),
                    encryptedCredentials: encryptModelCredentials(credentials, env.AUTH_SECRET),
                    isDefault,
                })
                .returning();

            if (!model) {
                throw internalServerError();
            }

            return toAdminModelRecord(model, env.AUTH_SECRET);
        });
    });
}
