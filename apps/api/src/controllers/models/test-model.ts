import { decryptModelCredentials, normalizeModelId } from "@kiwi/ai/models";
import { probeModelConfiguration } from "@kiwi/ai/probe";
import { and, eq } from "@kiwi/db/drizzle";
import { tryDb } from "@kiwi/db/effect";
import { modelsTable } from "@kiwi/db/tables/models";
import { invalidModelError, modelNotFoundError } from "@kiwi/contracts/errors";
import type { ModelTestInput } from "@kiwi/contracts/models";
import * as Effect from "effect/Effect";
import { env } from "../../env";
import { requireOrganizationAdmin } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError, tryApiSync } from "../_shared/api-effect";
import { assertCreateModelInput, normalizeCredentials } from "./model-credentials";

export function testModel(input: { user: AuthUser; body: ModelTestInput }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const membership = yield* requireOrganizationAdmin(input.user);
            let apiKey = input.body.credentials.apiKey;

            if (!apiKey) {
                apiKey = yield* getStoredModelApiKey({
                    organizationId: membership.organizationId,
                    modelId: input.body.model_id,
                });
            }

            const credentials = normalizeCredentials({
                apiKey,
                url: input.body.credentials.url,
                resourceName: input.body.credentials.resourceName,
            });
            const providerModel = input.body.provider_model.trim();

            yield* tryApiSync(() =>
                assertCreateModelInput({
                    type: input.body.type,
                    adapter: input.body.adapter,
                    providerModel,
                    credentials,
                })
            );

            return yield* Effect.tryPromise({
                try: () =>
                    probeModelConfiguration({
                        type: input.body.type,
                        adapter: input.body.adapter,
                        providerModel,
                        credentials,
                    }),
                catch: toApiError,
            });
        }),
        toApiError
    );
}

function getStoredModelApiKey(input: { organizationId: string; modelId?: string }) {
    return Effect.gen(function* () {
        const modelId = input.modelId;
        if (!modelId) {
            return yield* Effect.fail(invalidModelError());
        }

        const [model] = yield* tryDb((db) =>
            db
                .select({ encryptedCredentials: modelsTable.encryptedCredentials })
                .from(modelsTable)
                .where(
                    and(
                        eq(modelsTable.organizationId, input.organizationId),
                        eq(modelsTable.modelId, normalizeModelId(modelId))
                    )
                )
                .limit(1)
        );

        if (!model) {
            return yield* Effect.fail(modelNotFoundError());
        }

        return yield* tryApiSync(() => decryptModelCredentials(model.encryptedCredentials, env.AUTH_SECRET).apiKey);
    });
}
