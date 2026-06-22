import * as Effect from "effect/Effect";
import { roleIncludes } from "@kiwi/auth/permissions";
import { toAdminModelRecord, toPublicModelRecord } from "@kiwi/ai/models";
import { tryDb } from "@kiwi/db/effect";
import { modelsTable } from "@kiwi/db/tables/models";
import type { ModelQuery } from "@kiwi/contracts/models";
import { and, asc, eq } from "@kiwi/db/drizzle";
import { env } from "../../env";
import { requireOrganizationMembership } from "../../lib/team/access";
import type { AuthUser } from "../../middleware/auth";
import { toApiError } from "../_shared/api-effect";

export function listModels(input: { user: AuthUser; query: ModelQuery }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const membership = yield* requireOrganizationMembership(input.user);
            const organizationId = membership.organizationId;
            const isAdmin = roleIncludes(membership.role, "admin");

            if (!isAdmin) {
                const models = yield* tryDb((db) =>
                    db
                        .select({
                            modelId: modelsTable.modelId,
                            displayName: modelsTable.displayName,
                            isDefault: modelsTable.isDefault,
                        })
                        .from(modelsTable)
                        .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, "text")))
                        .orderBy(asc(modelsTable.displayName), asc(modelsTable.modelId))
                );

                return models.map(toPublicModelRecord);
            }

            const models = yield* tryDb((db) =>
                db
                    .select()
                    .from(modelsTable)
                    .where(
                        input.query.type
                            ? and(
                                  eq(modelsTable.organizationId, organizationId),
                                  eq(modelsTable.type, input.query.type)
                              )
                            : eq(modelsTable.organizationId, organizationId)
                    )
                    .orderBy(asc(modelsTable.type), asc(modelsTable.displayName), asc(modelsTable.modelId))
            );

            return models.map((model) => toAdminModelRecord(model, env.AUTH_SECRET));
        }),
        toApiError
    );
}
