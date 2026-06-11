import { roleIncludes } from "@kiwi/auth/permissions";
import {
    allocateModelId,
    assertValidModelConfiguration,
    decryptModelCredentials,
    encryptModelCredentials,
    lockModelOrganization,
    normalizeModelId,
    toAdminModelRecord,
    toPublicModelRecord,
    type ModelCredentials,
} from "@kiwi/ai/models";
import { db } from "@kiwi/db";
import {
    AI_MODEL_ADAPTER_VALUES,
    AI_MODEL_TYPE_VALUES,
    modelsTable,
    type AiModelAdapter,
    type AiModelType,
} from "@kiwi/db/tables/models";
import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import Elysia from "elysia";
import z from "zod";
import { env } from "../env";
import { requireOrganizationAdmin, requireOrganizationMembership } from "../lib/team-access";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

type RouteStatus = (code: number, body: unknown) => unknown;
type ModelQueryRunner = {
    select: typeof db.select;
};

const modelTypeSchema = z.enum(AI_MODEL_TYPE_VALUES);
const modelAdapterSchema = z.enum(AI_MODEL_ADAPTER_VALUES);
const credentialsSchema = z.object({
    apiKey: z.string().trim().min(1),
    url: z.string().trim().min(1).optional(),
    resourceName: z.string().trim().min(1).optional(),
});

const createModelSchema = z.object({
    model_id: z.string().trim().min(1),
    display_name: z.string().trim().min(1),
    type: modelTypeSchema,
    adapter: modelAdapterSchema,
    provider_model: z.string().trim().min(1),
    credentials: credentialsSchema,
    is_default: z.boolean().optional(),
});

// On PATCH every credential field is optional: omitted fields keep their
// stored value, an empty url/resourceName clears it. Only the API key is a
// secret; it can never be read back, only replaced.
const patchCredentialsSchema = z.object({
    apiKey: z.string().trim().min(1).optional(),
    url: z.string().trim().optional(),
    resourceName: z.string().trim().optional(),
});

const patchModelSchema = z.object({
    display_name: z.string().trim().min(1).optional(),
    adapter: modelAdapterSchema.optional(),
    provider_model: z.string().trim().min(1).optional(),
    credentials: patchCredentialsSchema.optional(),
});

function mapModelError(status: RouteStatus, error: unknown) {
    if (!(error instanceof Error)) {
        return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }

    switch (error.message) {
        case API_ERROR_CODES.UNAUTHORIZED:
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        case API_ERROR_CODES.FORBIDDEN:
            return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
        case API_ERROR_CODES.MODEL_NOT_FOUND:
            return status(404, errorResponse("Model not found", API_ERROR_CODES.MODEL_NOT_FOUND));
        case API_ERROR_CODES.INVALID_MODEL:
            return status(400, errorResponse("Invalid model", API_ERROR_CODES.INVALID_MODEL));
        case API_ERROR_CODES.MODEL_NOT_CONFIGURED:
            return status(
                400,
                errorResponse(
                    "Define a model for this organization before using AI features",
                    API_ERROR_CODES.MODEL_NOT_CONFIGURED
                )
            );
        default:
            return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }
}

function normalizeCredentials(credentials: ModelCredentials): ModelCredentials {
    return {
        apiKey: credentials.apiKey.trim(),
        ...(credentials.url ? { url: credentials.url.trim() } : {}),
        ...(credentials.resourceName ? { resourceName: credentials.resourceName.trim() } : {}),
    };
}

function mergeCredentials(stored: ModelCredentials, patch: z.infer<typeof patchCredentialsSchema>): ModelCredentials {
    return normalizeCredentials({
        apiKey: patch.apiKey ?? stored.apiKey,
        url: patch.url !== undefined ? patch.url : stored.url,
        resourceName: patch.resourceName !== undefined ? patch.resourceName : stored.resourceName,
    });
}

function assertCreateModelInput(input: {
    type: AiModelType;
    adapter: AiModelAdapter;
    providerModel: string;
    credentials: ModelCredentials;
}) {
    assertValidModelConfiguration(input);
}

async function runModelAction<T>(options: {
    status: RouteStatus;
    user: AuthUser | null | undefined;
    action: (user: AuthUser) => Promise<T>;
    success: (value: T) => unknown;
}) {
    if (!options.user) {
        return options.status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
    }

    const result = await Result.tryPromise(async () => options.action(options.user!));
    if (result.isErr()) {
        return mapModelError(options.status, result.error);
    }

    return options.success(result.value);
}

async function getModelForUpdate(queryRunner: ModelQueryRunner, organizationId: string, modelId: string) {
    const [model] = await queryRunner
        .select()
        .from(modelsTable)
        .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.modelId, normalizeModelId(modelId))))
        .limit(1);

    if (!model) {
        throw new Error(API_ERROR_CODES.MODEL_NOT_FOUND);
    }

    return model;
}

export const modelsRoute = new Elysia({ prefix: "/models" })
    .use(authMiddleware)
    .get(
        "/",
        async ({ query, status, user }) =>
            runModelAction({
                user,
                status,
                action: async (currentUser) => {
                    const membership = await requireOrganizationMembership(currentUser);
                    const organizationId = membership.organizationId;
                    const isAdmin = roleIncludes(membership.role, "admin");

                    if (!isAdmin) {
                        const models = await db
                            .select({
                                modelId: modelsTable.modelId,
                                displayName: modelsTable.displayName,
                                isDefault: modelsTable.isDefault,
                            })
                            .from(modelsTable)
                            .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, "text")))
                            .orderBy(asc(modelsTable.displayName), asc(modelsTable.modelId));

                        return models.map(toPublicModelRecord);
                    }

                    const models = await db
                        .select()
                        .from(modelsTable)
                        .where(
                            query.type
                                ? and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, query.type))
                                : eq(modelsTable.organizationId, organizationId)
                        )
                        .orderBy(asc(modelsTable.type), asc(modelsTable.displayName), asc(modelsTable.modelId));

                    return models.map((model) => toAdminModelRecord(model, env.AUTH_SECRET));
                },
                success: (value) => status(200, successResponse(value)),
            }),
        {
            query: z.object({
                type: modelTypeSchema.optional(),
            }),
        }
    )
    .post(
        "/",
        async ({ body, status, user }) =>
            runModelAction({
                user,
                status,
                action: async (currentUser) => {
                    const membership = await requireOrganizationAdmin(currentUser);
                    const organizationId = membership.organizationId;
                    const credentials = normalizeCredentials(body.credentials);
                    const providerModel = body.provider_model.trim();

                    assertCreateModelInput({
                        type: body.type,
                        adapter: body.adapter,
                        providerModel,
                        credentials,
                    });

                    return db.transaction(async (tx) => {
                        await lockModelOrganization(tx, organizationId);
                        const modelId = await allocateModelId(tx, organizationId, body.model_id);
                        const [existingTypeModel] = await tx
                            .select({ id: modelsTable.id })
                            .from(modelsTable)
                            .where(and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, body.type)))
                            .limit(1);
                        const isDefault = body.is_default === true || !existingTypeModel;

                        if (isDefault) {
                            await tx
                                .update(modelsTable)
                                .set({ isDefault: false })
                                .where(
                                    and(eq(modelsTable.organizationId, organizationId), eq(modelsTable.type, body.type))
                                );
                        }

                        const [model] = await tx
                            .insert(modelsTable)
                            .values({
                                organizationId,
                                modelId,
                                displayName: body.display_name.trim(),
                                type: body.type,
                                adapter: body.adapter,
                                providerModel,
                                encryptedCredentials: encryptModelCredentials(credentials, env.AUTH_SECRET),
                                isDefault,
                            })
                            .returning();

                        if (!model) {
                            throw new Error(API_ERROR_CODES.INTERNAL_SERVER_ERROR);
                        }

                        return toAdminModelRecord(model, env.AUTH_SECRET);
                    });
                },
                success: (value) => status(201, successResponse(value)),
            }),
        {
            body: createModelSchema,
        }
    )
    .patch(
        "/:modelId",
        async ({ body, params, status, user }) =>
            runModelAction({
                user,
                status,
                action: async (currentUser) => {
                    const membership = await requireOrganizationAdmin(currentUser);
                    const organizationId = membership.organizationId;

                    return db.transaction(async (tx) => {
                        await lockModelOrganization(tx, organizationId);
                        const currentModel = await getModelForUpdate(tx, organizationId, params.modelId);
                        const nextAdapter = body.adapter ?? currentModel.adapter;
                        const nextProviderModel = body.provider_model?.trim() ?? currentModel.providerModel;
                        const shouldValidateModel =
                            body.adapter !== undefined ||
                            body.provider_model !== undefined ||
                            body.credentials !== undefined;
                        const modelUpdates: {
                            displayName?: string;
                            adapter?: AiModelAdapter;
                            providerModel?: string;
                            encryptedCredentials?: string;
                        } = {};

                        if (body.display_name !== undefined) {
                            modelUpdates.displayName = body.display_name.trim();
                        }

                        if (body.adapter !== undefined) {
                            modelUpdates.adapter = nextAdapter;
                        }

                        if (body.provider_model !== undefined) {
                            modelUpdates.providerModel = nextProviderModel;
                        }

                        if (shouldValidateModel) {
                            const stored = decryptModelCredentials(currentModel.encryptedCredentials, env.AUTH_SECRET);
                            const credentials = body.credentials ? mergeCredentials(stored, body.credentials) : stored;

                            assertCreateModelInput({
                                type: currentModel.type,
                                adapter: nextAdapter,
                                providerModel: nextProviderModel,
                                credentials,
                            });

                            if (body.credentials) {
                                modelUpdates.encryptedCredentials = encryptModelCredentials(
                                    credentials,
                                    env.AUTH_SECRET
                                );
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
                            throw new Error(API_ERROR_CODES.MODEL_NOT_FOUND);
                        }

                        return toAdminModelRecord(model, env.AUTH_SECRET);
                    });
                },
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: z.object({
                modelId: z.string(),
            }),
            body: patchModelSchema,
        }
    )
    .post(
        "/:modelId/default",
        async ({ params, status, user }) =>
            runModelAction({
                user,
                status,
                action: async (currentUser) => {
                    const membership = await requireOrganizationAdmin(currentUser);
                    const organizationId = membership.organizationId;

                    return db.transaction(async (tx) => {
                        await lockModelOrganization(tx, organizationId);
                        const [currentModel] = await tx
                            .select()
                            .from(modelsTable)
                            .where(
                                and(
                                    eq(modelsTable.organizationId, organizationId),
                                    eq(modelsTable.modelId, normalizeModelId(params.modelId))
                                )
                            )
                            .limit(1)
                            .for("update");

                        if (!currentModel) {
                            throw new Error(API_ERROR_CODES.MODEL_NOT_FOUND);
                        }

                        await tx
                            .update(modelsTable)
                            .set({ isDefault: false })
                            .where(
                                and(
                                    eq(modelsTable.organizationId, organizationId),
                                    eq(modelsTable.type, currentModel.type)
                                )
                            );

                        const [model] = await tx
                            .update(modelsTable)
                            .set({ isDefault: true })
                            .where(eq(modelsTable.id, currentModel.id))
                            .returning();

                        return toAdminModelRecord(model ?? currentModel, env.AUTH_SECRET);
                    });
                },
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: z.object({
                modelId: z.string(),
            }),
        }
    )
    .delete(
        "/:modelId",
        async ({ params, status, user }) =>
            runModelAction({
                user,
                status,
                action: async (currentUser) => {
                    const membership = await requireOrganizationAdmin(currentUser);
                    const organizationId = membership.organizationId;

                    await db.transaction(async (tx) => {
                        await lockModelOrganization(tx, organizationId);
                        const [currentModel] = await tx
                            .select()
                            .from(modelsTable)
                            .where(
                                and(
                                    eq(modelsTable.organizationId, organizationId),
                                    eq(modelsTable.modelId, normalizeModelId(params.modelId))
                                )
                            )
                            .limit(1)
                            .for("update");

                        if (!currentModel) {
                            throw new Error(API_ERROR_CODES.MODEL_NOT_FOUND);
                        }

                        await tx.delete(modelsTable).where(eq(modelsTable.id, currentModel.id));

                        if (!currentModel.isDefault) {
                            return;
                        }

                        const [replacement] = await tx
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
                            await tx
                                .update(modelsTable)
                                .set({ isDefault: true })
                                .where(eq(modelsTable.id, replacement.id));
                        }
                    });
                },
                success: () => status(204, null),
            }),
        {
            params: z.object({
                modelId: z.string(),
            }),
        }
    );
